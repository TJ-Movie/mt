export const STUDIO_EDITOR_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'cast', label: 'Cast & Crew' },
  { id: 'artwork', label: 'Artwork' },
  { id: 'media', label: 'Media' },
  { id: 'rights', label: 'Rights & Publishing' },
  { id: 'advanced', label: 'Advanced' },
] as const;

export type StudioEditorTab = (typeof STUDIO_EDITOR_TABS)[number]['id'];

export function isStudioEditorTab(value: string): value is StudioEditorTab {
  return STUDIO_EDITOR_TABS.some((tab) => tab.id === value);
}

export function isStudioEditorPanelVisible(
  activeTab: StudioEditorTab,
  panel: StudioEditorTab,
): boolean {
  return activeTab === panel;
}