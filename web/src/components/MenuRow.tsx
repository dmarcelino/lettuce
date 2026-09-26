import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";

/**
 * One row of a menu sheet — the same in every composer menu: a bold title, an
 * optional description in the body font, and the selection marked on the
 * right. `mark="check"` is a pick-one choice (a tick on the selected row),
 * `mark="checkbox"` a pick-several one (a box, filled when on); a plain action
 * row (a command) has no mark. Render inside `<ul className="menu-list">`.
 */
export function MenuRow({
  title,
  description,
  mark,
  selected = false,
  disabled = false,
  onClick,
}: {
  title: ReactNode;
  description?: ReactNode;
  mark?: "check" | "checkbox";
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`menu-row${selected ? " selected" : ""}`}
        disabled={disabled}
        onClick={onClick}
        aria-pressed={mark === "checkbox" ? selected : undefined}
        aria-current={mark === "check" && selected ? "true" : undefined}
      >
        <span className="menu-row-text">
          <span className="menu-row-title">{title}</span>
          {description ? <span className="menu-row-desc">{description}</span> : null}
        </span>
        {mark === "check" && selected ? <Icon name="check" className="menu-row-check" /> : null}
        {mark === "checkbox" ? (
          <span className={`menu-row-box${selected ? " on" : ""}`} aria-hidden="true">
            {selected ? <Icon name="check" /> : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}
