import type { ReactElement, ReactNode } from "react";

export function Panel(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <section
      style={{
        border: "1px solid var(--line)",
        borderRadius: 14,
        padding: 16,
        background: "var(--surface)"
      }}
    >
      <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 16 }}>{props.title}</h3>
      {props.children}
    </section>
  );
}

export function StatusBadge(props: { status: string }): ReactElement {
  const color = props.status === "FAILED" ? "#b42318" : props.status === "SUCCESS" ? "#067647" : "#0c4a6e";
  return (
    <span
      style={{
        display: "inline-block",
        borderRadius: 999,
        padding: "4px 10px",
        background: `${color}22`,
        color,
        fontWeight: 600
      }}
    >
      {props.status}
    </span>
  );
}
