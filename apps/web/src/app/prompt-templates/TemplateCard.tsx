"use client";

import type { ReactElement } from "react";
import type { PromptTemplate } from "./types";
import { CATEGORY_ICONS, CATEGORY_LABELS } from "./types";

type Props = {
  template: PromptTemplate;
  currentUserId: string;
  isAdmin: boolean;
  onView: (t: PromptTemplate) => void;
  onEdit: (t: PromptTemplate) => void;
  onDuplicate: (t: PromptTemplate) => void;
  onDelete: (t: PromptTemplate) => void;
};

export function TemplateCard({ template, currentUserId, isAdmin, onView, onEdit, onDuplicate, onDelete }: Props): ReactElement {
  const canEdit = isAdmin || (!template.isBuiltIn && template.ownerId === currentUserId);
  const canDelete = canEdit && !template.isBuiltIn;
  const icon = CATEGORY_ICONS[template.category] ?? "🤖";
  const label = CATEGORY_LABELS[template.category] ?? template.category;

  return (
    <div className="tpl-card">
      <div className="tpl-card-header">
        <span className="tpl-card-icon">{icon}</span>
        <div className="tpl-card-title-row">
          <span className="tpl-card-name">{template.name}</span>
          {template.isBuiltIn && <span className="tpl-badge tpl-badge-builtin">Built-in</span>}
          <span className="tpl-badge tpl-badge-category">{label}</span>
        </div>
      </div>
      {template.description && <p className="tpl-card-desc">{template.description}</p>}
      <div className="tpl-card-meta">
        <span className="tpl-card-owner">by {template.ownerUsername}</span>
        {template.shareScope === "all" && <span className="tpl-badge tpl-badge-shared">Shared with all</span>}
        {template.shareScope === "specific" && <span className="tpl-badge tpl-badge-shared">Shared</span>}
      </div>
      <div className="tpl-card-actions">
        {canEdit ? (
          <button type="button" className="ops-btn ops-btn-sm ops-btn-secondary" onClick={() => onEdit(template)}>
            Edit
          </button>
        ) : (
          <button type="button" className="ops-btn ops-btn-sm ops-btn-secondary" onClick={() => onView(template)}>
            View
          </button>
        )}
        <button type="button" className="ops-btn ops-btn-sm ops-btn-ghost" onClick={() => onDuplicate(template)}>
          Duplicate
        </button>
        {canDelete && (
          <button type="button" className="ops-btn ops-btn-sm ops-btn-ghost tpl-btn-danger" onClick={() => onDelete(template)}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
