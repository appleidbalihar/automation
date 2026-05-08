export type TemplateCategory = "general" | "devops" | "developer" | "solution_architect" | "security" | "custom";

export type PromptTemplate = {
  id: string;
  name: string;
  description: string | null;
  category: TemplateCategory;
  systemPromptBase?: string;
  responseStyle: string | null;
  toneInstructions: string | null;
  restrictionRules: string | null;
  ownerId: string;
  ownerUsername: string;
  isBuiltIn: boolean;
  shareScope: "private" | "all" | "specific";
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
};

export type TemplateFormState = {
  name: string;
  description: string;
  category: TemplateCategory;
  systemPromptBase: string;
  responseStyle: string;
  toneInstructions: string;
  restrictionRules: string;
  shareScope: "private" | "all" | "specific";
  isBuiltIn: boolean;
};

export const EMPTY_TEMPLATE_FORM: TemplateFormState = {
  name: "",
  description: "",
  category: "general",
  systemPromptBase: "",
  responseStyle: "",
  toneInstructions: "",
  restrictionRules: "",
  shareScope: "private",
  isBuiltIn: false
};

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  general: "General",
  devops: "DevOps",
  developer: "Developer",
  solution_architect: "Solution Architect",
  security: "Security",
  custom: "Custom"
};

export const CATEGORY_ICONS: Record<TemplateCategory, string> = {
  general: "🤖",
  devops: "🔧",
  developer: "💻",
  solution_architect: "🏗️",
  security: "🔒",
  custom: "✏️"
};
