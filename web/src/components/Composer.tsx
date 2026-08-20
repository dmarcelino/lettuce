import { useRef, useState } from "react";

interface Props {
  disabled: boolean;
  processing: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function Composer({ disabled, processing, onSend, onAbort }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    const textarea = textareaRef.current;
    if (textarea) textarea.style.height = "auto";
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder={disabled ? "Select a conversation" : "Message the agent…"}
        disabled={disabled}
        onChange={(event) => {
          setValue(event.target.value);
          const textarea = event.target;
          textarea.style.height = "auto";
          textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
        }}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is a newline. On touch keyboards Enter is
          // usually a newline key, so the send button carries the same action.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {processing ? (
        <button type="button" className="icon-button stop" onClick={onAbort} title="Stop">
          ■
        </button>
      ) : (
        <button
          type="submit"
          className="icon-button send"
          disabled={disabled || !value.trim()}
          title="Send"
        >
          ↑
        </button>
      )}
    </form>
  );
}
