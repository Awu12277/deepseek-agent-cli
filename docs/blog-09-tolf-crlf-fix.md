# 一个 `\r` 引发的重试循环：用 toLf 治好 AI Agent 的 CRLF 匹配病

> 本文记录的是 [dskcode](https://github.com/Awu12277/deepseek-agent-cli) 开发过程中踩到的一个坑。
>
> dskcode 是一个基于 DeepSeek 的 AI 编程助手终端 CLI 工具，用 TypeScript 从零实现。它让 LLM 通过一组内置工具（`read_file` / `write_file` / `edit_file` / `multi_edit` / `delete_range` / `bash` / `glob` / `grep` 等）直接在终端里读写文件、执行命令、搜索代码，完成实际的编码任务。跨平台（macOS / Linux / Windows）是它的基本盘，而这次踩的坑恰恰就出在跨平台上。
>
> 仓库地址：**https://github.com/Awu12277/deepseek-agent-cli** ，欢迎 Star。

**TL;DR:** 我在写 dskcode 的文件编辑工具时，在 Windows 上反复撞上 `TEXT_NOT_FOUND`。根因是文件是 CRLF，LLM 给的 `old_text` 是 LF，`indexOf` 字符串精确匹配直接整段失败，模型陷入「读文件 → 改 → 失败 → 再读 → 再改」的死循环。解法很小：加一个 `toLf` 函数，匹配前把文件内容和待匹配文本都归一化成 LF，落盘时再用 `normalizeEol` 还原成原文件的 CRLF。一个函数，三连失败变一次成功。

适用读者：写 AI Agent / LLM 工具链、做代码编辑自动化、或者任何在 Node 里做「字符串精确替换文件内容」的开发者。尤其如果你跨 Windows / macOS 协作，这篇能帮你少踩一个很隐蔽的坑。

## 问题长什么样

我维护的 `agent-cli` 有几个写文件的工具：`edit_file`、`multi_edit`、`delete_range`。逻辑很朴素——读文件，`indexOf` 找到 `old_text`，替换成 `new_text`，写回去。在 macOS 上跑得好好的，一上 Windows 就开始抽风。

抽风的方式很典型：模型调用 `edit_file`，工具返回 `TEXT_NOT_FOUND`；模型以为自己抄错了，重新 `read_file`，再调 `edit_file`，还是 `TEXT_NOT_FOUND`；再来一次，依旧失败。会话日志 `e65f0205` 里 round 8 / 10 / 13 连着三次同样的错误码，token 烧了一堆，文件一个字没改。

更恶心的是，Reflector（我给 Agent 写的「失败反思」模块）本来应该在这种时候给模型一个提示，结果它把 `TEXT_NOT_FOUND` 误判成了「写根外」（路径越权），注入了一条完全跑偏的提示，模型更懵了。

## 根因：`\r\n` ≠ `\n`，`indexOf` 不背锅

先看问题出在哪。`edit_file` 原来的核心代码长这样：

```ts
const content = await readFile(filePath, "utf-8");
const firstIndex = content.indexOf(args.old_text);
if (firstIndex === -1) {
  return { success: false, data: "未找到 old_text", error: "TEXT_NOT_FOUND" };
}
const newContent = content.replace(args.old_text, args.new_text);
await writeFileWithEol(filePath, content, newContent);
```

看起来没毛病。但在 Windows 上，`content` 长这样（注意每行末尾的 `\r`）：

```
"line one\r\nfoo bar\r\nline three"
```

而 LLM 给的 `old_text` 是它从 `read_file` 输出里「看」到的内容。问题是——`read_file` 原来是这样拆行的：

```ts
const lines = content.split("\n");
```

`"line one\r\nfoo bar\r\nline three".split("\n")` 会得到 `["line one\r", "foo bar\r", "line three"]`。每行末尾挂着一个 `\r`，展示给模型的时候虽然肉眼不太看得出来，但模型一旦把这段内容当作 `old_text` 原样回传，字符串就变成了 LF 版本（`\n`），而文件里是 CRLF（`\r\n`）。

`"line one\r\nfoo bar\r\nline three".indexOf("foo bar")` 还能凑巧命中（因为 `foo bar` 中间没换行）。但只要 `old_text` 跨行——比如 `"b\nc\nd"`——就彻底完蛋：文件里是 `"b\r\nc\r\nd"`，`indexOf("b\nc\nd")` 返回 `-1`，铁定 `TEXT_NOT_FOUND`。

一句话总结根因：

> **匹配空间不一致**。文件内容是 CRLF，LLM 提供的 `old_text` 是 LF，`indexOf` 是字节级精确匹配，`\r\n` 和 `\n` 就是两个不同的字符串，整段失配。

## 解法：匹配搬进 LF 空间，落盘再还原原 EOL

思路其实很直接。既然矛盾出在「文件是 CRLF、LLM 给的是 LF」，那就**让匹配只发生在 LF 空间**，落盘的时候再还原成原文件本来 的 EOL。这样既不会误匹配，也不会产生 EOL 翻转的 diff 噪声。

### 第一步：一个 `toLf` 函数

新加的 `toLf` 只做一件事——把行尾统一成 `\n`，**仅供匹配/比较用，不落盘**：

```ts
// src/tool/eol.ts
/**
 * 把行尾统一为 LF（\n），仅供「匹配 / 比较」使用，不要用于落盘。
 *
 * 策略：匹配前对文件内容与待匹配文本都做 LF 归一化，落盘时再由
 * normalizeEol 还原为原 EOL，既避免误匹配又不产生 EOL 翻转噪声。
 * 仅替换 `\r\n` → `\n`；罕见的独立 `\r`（旧 Mac 风格）也一并归一。
 */
export function toLf(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
```

两个细节值得说一下：

- **快路径**：`if (!text.includes("\r")) return text` —— 大部分文件本来就是 LF，直接返回原字符串，不创建新对象，零成本。
- **两步 replace**：先 `\r\n` → `\n`，再单独的 `\r` → `\n`。顺序不能反，否则 `\r\n` 会先被拆成 `\n\n`，行数翻倍。独立 `\r`（老 Mac 风格）现在基本见不到了，但顺手归一一下保持行语义完整。

### 第二步：`edit_file` 在 LF 空间匹配，落盘还原

改完的 `edit_file` 核心逻辑：

```ts
// src/tool/builtins/edit-file.ts
const content = await readFile(filePath, "utf-8");

// 匹配在 LF 归一化空间进行：原文件可能是 CRLF，而 LLM 习惯用 LF
// 编写 old_text/new_text。这里把两端都归一为 LF 再 indexOf，落盘时
// 再由 normalizeEol 还原为原 EOL。
const contentN = toLf(content);
const oldTextN = toLf(args.old_text);

const firstIndex = contentN.indexOf(oldTextN);
if (firstIndex === -1) {
  return { success: false, data: "未找到 old_text", error: "TEXT_NOT_FOUND" };
}

const secondIndex = contentN.indexOf(oldTextN, firstIndex + 1);
if (secondIndex !== -1) {
  return { success: false, data: "old_text 出现多次", error: "TEXT_MULTIPLE_MATCHES" };
}

// 在 LF 空间拼出新内容
const newContentN =
  contentN.slice(0, firstIndex) +
  toLf(args.new_text) +
  contentN.slice(firstIndex + oldTextN.length);

// 按原文件 EOL 还原后再落盘，diff 也基于实际落盘内容计算
const writtenContent = normalizeEol(content, newContentN);
await writeFile(filePath, writtenContent, "utf-8");
```

注意三个点：

1. **两端都归一**：`content` 和 `args.old_text` 都过 `toLf`。只归一一端没用，必须对齐到同一个空间。
2. **拼新内容也在 LF 空间做**：`new_text` 也过 `toLf`，然后用 `slice` 拼接，避免 `replace` 在归一化后的字符串上行为不直观。
3. **落盘前 `normalizeEol` 还原**：用原文件 `content` 探测 EOL 风格（CRLF 还是 LF），把 LF 空间的 `newContentN` 转回去。这一步是关键——不做的话，整个文件的行尾就从 CRLF 翻转成 LF 了，`git diff` 全文件飘红，模型看到一堆「假改动」又会陷入修复循环。

`normalizeEol` 的实现长这样，核心是「按原 EOL 重新拼接行 + 保留原文件是否以行尾符结尾的特征」：

```ts
// src/tool/eol.ts
export function normalizeEol(originalContent: string, newContent: string): string {
  const targetEol = detectEol(originalContent); // 探测原文件是 \r\n 还是 \n
  const lines = newContent.replace(/\r\n/g, "\n").split("\n");
  const originalHasTrailing = hasTrailingNewline(originalContent);
  const newHasTrailing = lines.length > 0 && lines[lines.length - 1] === "";

  let result = lines.join(targetEol);
  if (originalHasTrailing && !newHasTrailing) {
    result += targetEol;       // 原文件有尾换行，新内容没有，补上
  }
  if (!originalHasTrailing && newHasTrailing) {
    result = result.slice(0, -targetEol.length); // 反之去掉
  }
  return result;
}
```

### 第三步：`read_file` 也归一化展示

光改写工具不够。`read_file` 展示给 LLM 的内容也得是干净的 LF，否则模型看到的还是带 `\r` 的行，下次还是写不对 `old_text`。改一行：

```ts
// src/tool/builtins/read-file.ts
const content = await readFile(filePath, "utf-8");
// 按 LF 归一化后拆行：CRLF 文件每行末尾不再残留 `\r`，展示干净，
// 也与 edit_file / multi_edit / delete_range 的 LF 归一化匹配保持一致
// —— LLM 看到什么就能直接拿去作 old_text/锚点。
const lines = toLf(content).split("\n");
```

这是个一致性约束：**读工具展示的空间，必须和写工具匹配的空间一致**。否则读出来的内容模型拿去当 `old_text`，写工具又匹配不上，问题原样复现。

### 同步改 `multi_edit` 和 `delete_range`

`multi_edit` 是多步替换，同样的套路：整个替换循环在 LF 空间跑，最后一步 `normalizeEol` 还原落盘。

`delete_range` 用锚点（`startAnchor` / `endAnchor`）定位行号，锚点比较也要先 `toLf`：

```ts
// src/tool/builtins/delete-range.ts
function findUniqueLine(lines: string[], anchor: string, label: string) {
  const anchorN = toLf(anchor);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (toLf(lines[i]!) === anchorN) {  // 行内容也归一化再比
      matches.push(i);
    }
  }
  // ...
}
```

行拆分也得是 `toLf(content).split("\n")`，否则每行带 `\r`，锚点（LF）永远比不上。

## 验证：CRLF 文件，LF 编写，匹配成功且保留 CRLF

测试用例直接对准会话日志里的失败场景：

```ts
// tests/tool.test.ts
it("CRLF 文件用 LF 的 old_text 仍能匹配且保留原行尾", async () => {
  const crlfFile = join(testDir, "crlf-test.txt");
  await writeFile(crlfFile, "line one\r\nfoo bar\r\nline three", "utf-8");
  const result = await editFileTool.execute(
    { path: crlfFile, old_text: "foo bar", new_text: "baz qux" },
    createTestContext(),
  );
  expect(result.success).toBe(true);
  const after = await readFile(crlfFile, "utf-8");
  expect(after).toBe("line one\r\nbaz qux\r\nline three");  // CRLF 保留
});

it("CRLF 文件多行 old_text（LF 编写）能匹配", async () => {
  const crlfFile = join(testDir, "crlf-multi.txt");
  await writeFile(crlfFile, "a\r\nb\r\nc\r\nd", "utf-8");
  const result = await editFileTool.execute(
    { path: crlfFile, old_text: "b\nc\nd", new_text: "x\ny" },  // LF 编写
    createTestContext(),
  );
  expect(result.success).toBe(true);
  const after = await readFile(crlfFile, "utf-8");
  expect(after).toBe("a\r\nx\r\ny");  // 落盘还原 CRLF
});
```

第二个测试是关键：`old_text` 是 `"b\nc\nd"`（LF），文件是 `"a\r\nb\r\nc\r\nd"`（CRLF）。修复前 `indexOf("b\nc\nd")` 必然 `-1`，修复后归一化匹配命中，落盘还原成 `"a\r\nx\r\ny"`，CRLF 保住，git diff 只会显示真正改动的两行。

`multi_edit`（多步替换 + `replaceAll`）和 `delete_range`（LF 锚点定位）也都有对应测试，全过。

## Trade-offs

这个方案不完美，有几个地方值得拎出来说。以下每一条都已记录在 [`bugfix/known-issues.md`](../bugfix/known-issues.md) 里，标了状态和修复方向，后续要动可直接照着改。

**1. 归一化匹配可能「误命中」**

`toLf` 之后，`old_text` 里如果本来就有 `\r`（比如用户真就想匹配一个带 `\r` 的内容），会被归一掉，可能匹配到原本不该匹配的位置。实际场景里 LLM 几乎不会主动写 `\r`，这个风险很低，但理论上存在。如果要做更严格，可以在归一化前先判断 `old_text` 是否含 `\r`，含 `\r` 就跳过归一化直接比——但这会让逻辑复杂一截，收益不大，我没做。

**2. 独立 `\r`（老 Mac 风格）被强行转成 `\n`**

`toLf` 的第二步 `replace(/\r/g, "\n"` 会把罕见的独立 `\r` 也转成 `\n`。现代项目基本不会有这种行尾，但如果你的代码库里有，落盘后行尾风格会变。`normalizeEol` 只探测 `\r\n` vs `\n`，不处理独立 `\r`，所以独立 `\r` 的文件会被默默转成 LF。可接受，但要知道。

**3. 性能：多一次全量 replace**

`toLf` 对含 `\r` 的文件会做两次正则 replace。对大文件（比如几 MB 的 minified JS）有开销，但 `includes("\r")` 的快路径能挡掉所有 LF 文件，只有 CRLF 文件才走 replace。实测对几百 KB 的源码文件无感，没做进一步优化。

**4. 只解决了「读-写」一致性，没解决「外部并发改」**

如果模型读完文件、准备改的瞬间，外部（比如用户手动编辑）改了文件，`old_text` 还是会对不上。这是经典的 TOCTOU 问题，`toLf` 不解决它，需要文件锁或者乐观并发控制，那是另一个话题。

## 结论

整个修复的核心其实就一句话：**让匹配发生在同一个行尾空间里**。

`toLf` 是匹配空间，`normalizeEol` 是落盘空间，`read_file` 的展示空间和写工具的匹配空间保持一致。三个空间对齐了，CRLF / LF 的差异就不再是问题。模型看到什么就能拿去用，工具在内部做归一化，落盘还原原貌，git diff 干干净净。

这个坑之所以隐蔽，是因为在 macOS 上开发根本碰不到——LF 文件配 LF 的 `old_text`，天然一致。一上 Windows，CRLF 文件配 LF 的 `old_text`，空间错位，`indexOf` 字节级精确匹配直接摆烂。如果你也在做让 LLM 编辑代码的工具，跨平台测一下 Windows CRLF 文件，大概率你也有这个 bug，只是还没被触发。

一个 `toLf`，三个工具，一组测试，会话日志里 round 8/10/13 的三连失败变成一次过。性价比很高的修。

## Further Reading

- [POSIX 行尾 vs Windows 行尾的历史恩怨](https://en.wikipedia.org/wiki/Newline) —— 为什么这个世界同时存在 `\n` 和 `\r\n`
- [git 的 `core.autocrlf` 与 `.gitattributes`](https://git-scm.com/docs/gitattributes#_checking-out_and_checking-in) —— git 自己怎么处理 EOL 归一化，思路其实是同源的
- Node.js [Buffer.indexOf](https://nodejs.org/api/buffer.html#bufindexofvalue-byteoffset-encoding) —— 字节级匹配，不感知行尾语义
- LLM 工具设计里的「输入空间 / 工具空间一致性」—— Claude 的 [Computer Use](https://docs.anthropic.com/en/docs/build-with-claude/computer-use) 在坐标系统上也踩过类似的坑
