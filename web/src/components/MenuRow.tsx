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
        // The box already shows a checkbox row's state; the selected border is
        // for pick-one rows, where it marks the single choice.
        className={`menu-row${selected && mark !== "checkbox" ? " selected" : ""}`}
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

/**
 * An on/off setting outside a menu (a form, a settings pane, the sidebar): one
 * `MenuRow` checkbox in its own list, so every toggle in the app is the same
 * object as the Filter sheet's. Replaces the native checkbox, which rendered
 * in the platform's style and colour and sat at a different size per browser.
 */
export function ToggleRow({
  title,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <ul className="menu-list toggle-row">
      <MenuRow
        title={title}
        description={description}
        mark="checkbox"
        selected={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </ul>
  );
}
