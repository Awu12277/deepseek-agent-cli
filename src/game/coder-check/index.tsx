import { Box, Text, useInput, render } from "ink";
import { useState, useEffect, useRef, useCallback } from "react";

const GAME_W = 66;
const GAME_H = 20; // 6 行分数 + 14 行掉落单词
const SCORE_H = 6;
// const WORD_H = 14;
const MAX_WORDS = 10;
const CYBER_PALETTE = ["#00ffff", "#ff00ff", "#00ff41", "#ff1493", "#8b00ff"];

// 3×5 像素大号数字（每个像素 = ██，每数字 6 列）
const DIGIT_ART: Record<string, string[]> = {
  "0": [" ██████ ", "██    ██", "██    ██", "██    ██", " ██████ "],
  "1": ["   ██   ", " ████   ", "   ██   ", "   ██   ", " ██████ "],
  "2": [" ██████ ", "     ██ ", " ██████ ", " ██     ", " ██████ "],
  "3": [" ██████ ", "     ██ ", " ██████ ", "     ██ ", " ██████ "],
  "4": ["██    ██", "██    ██", " ██████ ", "     ██ ", "     ██ "],
  "5": [" ██████ ", " ██     ", " ██████ ", "     ██ ", " ██████ "],
  "6": [" ██████ ", " ██     ", " ██████ ", " ██   ██", " ██████ "],
  "7": [" ██████ ", "     ██ ", "    ██  ", "   ██   ", "  ██    "],
  "8": [" ██████ ", "██    ██", " ██████ ", "██    ██", " ██████ "],
  "9": [" ██████ ", "██    ██", " ██████ ", "     ██ ", " ██████ "],
};

function buildScoreLines(scoreStr: string): string[] {
  const lines = ["", "", "", "", ""];
  for (const ch of scoreStr) {
    const art = DIGIT_ART[ch] ?? DIGIT_ART["0"]!;
    for (let r = 0; r < 5; r++) {
      lines[r] += " " + (art[r] ?? "");
    }
  }
  // 左右各留 6 格间距
  const pad = 6;
  return lines.map((l) => " ".repeat(pad) + l);
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r};${g};${b}`;
}

// ─── 200 个常见单词 ────────────────────────────────────────────

const WORDS_BANK = [
  // ── 框架 & 库 ──
  "react", "vue", "next", "node", "axios", "express", "lodash", "jquery",
  "webpack", "vite", "babel", "eslint", "prettier", "tailwind", "bootstrap",
  "sass", "less", "postcss", "redux", "pinia", "vuex", "router",
  "nestjs", "socket", "graphql", "rest", "grpc", "prisma", "typeorm",

  // ── 前端 ──
  "html", "css", "jsx", "tsx", "dom", "spa", "ssr", "csr", "pwa",
  "component", "prop", "hook", "composable", "directive", "filter", "mixin",
  "template", "render", "virtual", "diff", "patch", "hydration",
  "responsive", "flexbox", "grid", "animation", "transition",

  // ── 后端 ──
  "api", "route", "middleware", "controller", "service", "module",
  "dto", "entity", "schema", "migration", "seeder", "factory",
  "auth", "jwt", "oauth", "session", "cookie", "token", "cors",
  "cache", "redis", "mq", "rabbit", "kafka", "nats",

  // ── 数据库 ──
  "sql", "mysql", "pg", "sqlite", "mongo", "redis", "orm",
  "table", "index", "query", "join", "union", "group", "order",
  "where", "having", "limit", "offset", "insert", "update", "delete",

  // ── DevOps ──
  "docker", "nginx", "linux", "bash", "shell", "yaml", "toml",
  "ci", "cd", "deploy", "rollback", "release", "build", "test",
  "lint", "format", "stage", "commit", "branch", "merge", "rebase",

  // ── 数据结构 & 算法 ──
  "array", "stack", "queue", "tree", "graph", "list", "map", "set",
  "sort", "search", "filter", "reduce", "map", "async", "await",
  "promise", "callback", "closure", "proxy", "reflect", "decorator",

  // ── 常用操作 ──
  "create", "read", "update", "delete", "crud", "parse", "stringify",
  "encode", "decode", "transform", "validate", "format", "parse",
  "upload", "download", "export", "import", "backup", "restore",

  // ── 类型 & 变量 ──
  "string", "number", "boolean", "object", "array", "tuple", "enum",
  "interface", "type", "class", "function", "method", "property",
  "public", "private", "static", "readonly", "optional", "abstract",
  "const", "let", "var", "void", "null", "undef", "never", "any",

  // ── 补充 ──
  "config", "logger", "monitor", "metric", "alert", "webhook",
  "endpoint", "payload", "header", "status", "timeout", "retry",
  "fallback", "circuit", "breaker", "throttle", "debounce",
  "scroll", "resize", "click", "hover", "focus", "blur",
];

function randomWord(used: Set<string>): string {
  let w: string;
  do { w = WORDS_BANK[Math.floor(Math.random() * WORDS_BANK.length)]!; }
  while (used.has(w));
  return w;
}

// ─── 游戏状态 ──────────────────────────────────────────────────

interface DropWord {
  text: string;
  row: number;
  col: number;
}

interface GameState {
  words: DropWord[];
  score: number;
  lives: number;
  speed: number;
  spawnTimer: number;
  gameOver: boolean;
  paused: boolean;
  typed: string;
  target: string | null;
  combo: number;
  message: string;
  messageTimer: number;
  usedWords: Set<string>;
}

function createInitialState(): GameState {
  return {
    words: [],
    score: 0,
    lives: 3,
    speed: 0.3,
    spawnTimer: 0,
    gameOver: false,
    paused: false,
    typed: "",
    target: null,
    combo: 0,
    message: "",
    messageTimer: 0,
    usedWords: new Set(),
  };
}

function pickTarget(s: GameState): string | null {
  // 选取最靠左的存活单词作为目标
  let best: DropWord | null = null;
  for (const w of s.words) {
    if (!best || w.col < best.col) best = w;
  }
  return best?.text ?? null;
}

// ─── 物理更新 ──────────────────────────────────────────────────

function update(s: GameState): void {
  if (s.paused || s.gameOver) return;

  // 生成新单词
  s.spawnTimer++;
  if (s.spawnTimer >= Math.max(20, 50 - Math.floor(s.speed * 15))) {
    s.spawnTimer = 0;
    if (s.words.length < MAX_WORDS) {
      const used = new Set(s.usedWords);
      for (const w of s.words) used.add(w.text);
      const text = randomWord(used);
      // 找空白行
      const usedRows = new Set(s.words.map((w) => w.row));
      let row = -1;
      for (let r = SCORE_H; r < GAME_H; r++) {
        if (!usedRows.has(r)) { row = r; break; }
      }
      if (row >= 0) {
        s.words.push({ text, row, col: GAME_W - 1 });
        s.usedWords.add(text);
      }
    }
  }

  // 移动单词
  for (const w of s.words) {
    w.col -= s.speed;
  }

  // 移除超出左边的 + 更新目标
  const before = s.words.length;
  s.words = s.words.filter((w) => w.col > -w.text.length);
  const removed = before - s.words.length;

  // 单词漏掉了 → 扣命
  if (removed > 0) {
    s.lives -= removed;
    s.typed = "";
    s.target = pickTarget(s);
    if (s.lives <= 0) {
      s.gameOver = true;
      s.words = [];
    }
  }

  // 更新目标
  s.target = pickTarget(s);

  // 消息计时
  if (s.messageTimer > 0) {
    s.messageTimer--;
    if (s.messageTimer <= 0) s.message = "";
  }
}

// ─── 画面渲染 ──────────────────────────────────────────────────

function buildGameView(s: GameState, scoreLines: string[], scoreColor: string, message: string): string[] {
  const rows: string[] = [];

  for (let y = 0; y < GAME_H; y++) {
    let line = "";

    // 分数区域（前 6 行）
    if (y < SCORE_H) {
      if (y < 5) {
        // 数字行 — 先补足宽度再套赛博朋克色
        const raw = (scoreLines[y] ?? "").padEnd(GAME_W);
        line = `\x1b[38;2;${hexToRgb(scoreColor)}m${raw}\x1b[0m`;
      } else if (y === 5) {
        // 第 6 行：连击 / 暂停
        if (s.combo >= 3) {
          const comboText = `${s.combo}连击!`;
          const pad = Math.floor((GAME_W - comboText.length) / 2);
          const comboColor = CYBER_PALETTE[s.combo % CYBER_PALETTE.length]!;
          const raw = " ".repeat(pad) + comboText + " ".repeat(GAME_W - pad - comboText.length);
          line = `\x1b[38;2;${hexToRgb(comboColor)}m${raw}\x1b[0m`;
        } else if (s.paused) {
          const pauseText = "暂停";
          const pad = Math.floor((GAME_W - pauseText.length) / 2);
          line = " ".repeat(pad) + pauseText;
          line = line.padEnd(GAME_W);
        }
      }
      // 补全到 GAME_W 宽度
      line = line.padEnd(GAME_W);
    } else {
      // 单词区域
      // 第 1 行显示消息（如果有）
      if (y === SCORE_H && message) {
        const pad = Math.floor((GAME_W - message.length) / 2);
        const raw = " ".repeat(pad) + message + " ".repeat(GAME_W - pad - message.length);
        const msgColor = CYBER_PALETTE[Math.floor(Math.random() * CYBER_PALETTE.length)]!;
        line = `\x1b[38;2;${hexToRgb(msgColor)}m${raw}\x1b[0m`;
      } else {
        for (let x = 0; x < GAME_W; x++) {
          const word = s.words.find((w) => {
            const charIdx = x - Math.floor(w.col);
            return charIdx >= 0 && charIdx < w.text.length && w.row === y;
          });
          if (word) {
            const charIdx = x - Math.floor(word.col);
            const ch = word.text[charIdx]!;
            const isTarget = word.text === s.target;
            const typedIdx = s.target === word.text ? s.typed.length : 0;
            const isTyped = isTarget && charIdx < typedIdx;
            if (isTarget) {
              line += isTyped ? `\x1b[92m${ch}\x1b[0m` : `\x1b[97m${ch}\x1b[0m`;
            } else {
              line += `\x1b[90m${ch}\x1b[0m`;
            }
          } else {
            line += " ";
          }
        }
      }
    }

    rows.push(line);
  }
  return rows;
}

// ─── Ink 组件 ──────────────────────────────────────────────────

interface CoderCheckProps {
  onExit: () => void;
}

function CoderCheck({ onExit: _onExit }: CoderCheckProps) {
  const stateRef = useRef<GameState>(createInitialState());
  const [tick, setTick] = useState(0);
  const [colorOffset, setColorOffset] = useState(0);
  const onExitRef = useRef(_onExit);
  onExitRef.current = _onExit;

  // 赛博朋克颜色动画
  useEffect(() => {
    const timer = setInterval(() => {
      setColorOffset((prev) => (prev + 1) % CYBER_PALETTE.length);
    }, 400);
    return () => clearInterval(timer);
  }, []);

  // 游戏循环
  useEffect(() => {
    const interval = setInterval(() => {
      update(stateRef.current);
      setTick((t) => t + 1);
    }, 60);
    return () => clearInterval(interval);
  }, []);

  useInput(
    useCallback((input, key) => {
      const s = stateRef.current;
      if (s.gameOver) {
        if (input === "r") {
          stateRef.current = createInitialState();
          setTick(0);
        } else if (input === "q" || key.escape) {
          onExitRef.current();
        }
        return;
      }

      if ((input === "p" && key.ctrl) || input === " ") {
        s.paused = !s.paused;
        return;
      }
      if ((input === "q" && key.ctrl) || key.escape) {
        onExitRef.current();
        return;
      }

      if (s.paused) return;

      // 打字输入
      if (input.length === 1 && input >= "a" && input <= "z") {
        // 选取目标
        if (!s.target) {
          s.target = pickTarget(s);
        }
        if (s.target) {
          const nextChar = s.target[s.typed.length];
          if (nextChar === input) {
            s.typed += input;
            // 检查是否完成
            if (s.typed === s.target) {
              // 移除该单词
              s.words = s.words.filter((w) => w.text !== s.target);
              s.combo++;
              // 连击 >= 3 时以当前分数翻倍奖励
              const prevScore = s.score;
              const basePts = s.target.length;
              const comboBonus = s.combo >= 3 ? s.score : 0;
              s.score += basePts + comboBonus;
              s.speed = s.speed + 0.02;

              // 每 500 分提速
              const prevMilestone = Math.floor(prevScore / 500);
              const newMilestone = Math.floor(s.score / 500);
              if (newMilestone > prevMilestone) {
                s.speed += 0.15;
              }

              // 超过 99999 分提示通关
              if (s.score >= 100000 && prevScore < 100000) {
                s.message = "恭喜通关! 难度最大化!";
                s.messageTimer = 100;
              }
              s.typed = "";
              s.target = pickTarget(s);
            }
          } else {
            // 打错字符，连击中断
            s.combo = 0;
          }
        }
      }
    }, []),
  );

  const s = stateRef.current;
  const scoreColor = CYBER_PALETTE[colorOffset]!;
  const scoreStr = String(s.score).padStart(5, "0");
  const scoreLines = buildScoreLines(scoreStr);
  const view = buildGameView(s, scoreLines, scoreColor, s.message);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void tick;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 顶栏：生命 + 速度 */}
      <Box flexDirection="row">
        <Text>
          生命 <Text color="red">{"♥".repeat(Math.max(0, s.lives))}</Text>
          {"  "}速度 <Text color="cyan">Lv.{Math.floor(s.speed * 10)}</Text>
        </Text>
      </Box>

      {/* 目标单词提示 */}
      {!s.gameOver && s.target && (
        <Box marginTop={1}>
          <Text>
            打字: <Text color="green">{s.typed}</Text>
            <Text color="white">{s.target.slice(s.typed.length)}</Text>
          </Text>
        </Box>
      )}

      {/* 游戏画面（含分数） */}
      <Box flexDirection="column" marginTop={1}>
        <Text>┌{"─".repeat(GAME_W)}┐</Text>
        {view.map((row, i) => (
          <Text key={i}>{`│${row}│`}</Text>
        ))}
        <Text>└{"─".repeat(GAME_W)}┘</Text>
      </Box>

      {/* 游戏结束 */}
      {s.gameOver && (
        <Box marginTop={1}>
          <Text bold color="red">
            游戏结束！
          </Text>
          <Text>
            {"  得分: "}<Text color="yellow">{s.score}</Text>
            {"  r 重开  q 退出"}
          </Text>
        </Box>
      )}

      {/* 操作提示 */}
      <Box marginTop={1}>
        <Text dimColor>
          {"打字消除单词  空格/Ctrl+P暂停  Ctrl+Q退出"}
        </Text>
      </Box>
    </Box>
  );
}

// ─── 导出 ──────────────────────────────────────────────────────

export default {
  id: "coder-check",
  name: "Coder Check",
  description: "极速打字游戏，输入单词消除它们！",
  play: async () => {
    await new Promise<void>((resolve) => {
      const { unmount } = render(
        <CoderCheck onExit={() => { unmount(); resolve(); }} />,
      );
    });
  },
};
