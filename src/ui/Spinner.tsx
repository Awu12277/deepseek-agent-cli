import { Text } from "ink";
import InkSpinner from "ink-spinner";

interface SpinnerProps {
  type?: "dots" | "line" | "bouncingBar" | "aesthetic";
  label?: string;
}

export function Spinner({ type = "dots", label }: SpinnerProps) {
  return (
    <Text>
      <Text color="cyan">
        <InkSpinner type={type} />
      </Text>
      {label ? <Text> {label}</Text> : null}
    </Text>
  );
}
