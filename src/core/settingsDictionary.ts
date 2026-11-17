// What each setting does, written into settings.schema.json with the types, limits and
// defaults that come from the schema itself. Editors show it on hover, and Claude reads it
// to show or change settings for the player.

export interface SettingEntry {
  text: string;
  /**
   * Claude must not change this setting or any setting under it. These control what Claude
   * may do, or where ED Chat reads files from; the player changes them from the tray menu.
   */
  playerOnly?: true;
}

export const PLAYER_ONLY_NOTE =
  "Player only: Claude must not change this. The player changes it in settings.json, from the tray menu, Open settings.";

const position = (what: string, prefix: string): Record<string, SettingEntry> => ({
  [prefix]: { text: `Where ${what} sits on the screen.` },
  [`${prefix}.anchor`]: { text: `The screen edge or corner that ${what} sits against.` },
  [`${prefix}.offsetX`]: { text: "Pixels from the left or right screen edge." },
  [`${prefix}.offsetY`]: { text: "Pixels from the top or bottom screen edge." },
  [`${prefix}.display`]: { text: "primary, or a monitor number: 0, 1 and so on." },
});

export const SETTINGS_DICTIONARY: Record<string, SettingEntry> = {
  hotkeys: {
    text:
      "Hotkeys. Each takes one key, such as Ctrl+Alt+C, or a list of keys for the same action. " +
      "Keys use Electron accelerator names.",
  },
  "hotkeys.scope": {
    text:
      "game: the keys work only while the game or the overlay is in front. always: they work " +
      "everywhere, except keys without a modifier.",
  },
  "hotkeys.openChat": { text: "Opens the chat directly." },
  "hotkeys.toggleIcon": { text: "Switches between the status strip and the small icon." },
  "hotkeys.showMore": {
    text: "The step key: each press shows the reply, then the whole reply, then the chat.",
  },
  "hotkeys.showHistory": { text: "Opens the conversation history." },
  "hotkeys.approve": { text: "Allows the tool that Claude asks to run." },
  "hotkeys.deny": { text: "Denies the tool that Claude asks to run." },
  "hotkeys.alwaysAllow": {
    text: "Allows the tool, and the same tool again without asking until /new.",
  },
  "hotkeys.cancel": { text: "Stops the reply." },
  "hotkeys.copyChip": {
    text: "Copies chip 1 to 9 from the reply. Must contain {n}, which stands for the number.",
  },
  "hotkeys.copyChipNumpad": {
    text: "Also copy chips with Ctrl+numpad 1 to 9. Windows changes Shift+numpad keys.",
  },
  "hotkeys.moveUp": { text: "Moves the overlay up." },
  "hotkeys.moveDown": { text: "Moves the overlay down." },
  "hotkeys.moveLeft": { text: "Moves the overlay left." },
  "hotkeys.moveRight": { text: "Moves the overlay right." },
  "hotkeys.nextDisplay": { text: "Moves the overlay to the next monitor." },
  "hotkeys.hudToggle": { text: "Shows or hides the activity panel." },
  "hotkeys.hudMode": {
    text: "Steps the activity panel through its modes: automatic, then each mode.",
  },
  "hotkeys.hudMove": { text: "Starts moving the activity panel with the move keys." },
  "hotkeys.routeNext": { text: "Copies the next route stop." },
  "hotkeys.routePrev": { text: "Copies the previous route stop." },

  strip: { text: "The status strip at rest." },
  "strip.lines": { text: "1: status only. 2: also the first line of the last reply." },
  "strip.keepChips": { text: "Keep the last reply's chips under the status line." },
  "strip.startAsIcon": {
    text: "Start as the small icon on the first run. Later runs remember the last choice.",
  },

  card: { text: "The card that shows a reply." },
  "card.maxLines": { text: "Reply lines shown before the more button." },
  "card.fadeSeconds": { text: "Seconds before the reply card closes." },
  "card.width": { text: "Card width in pixels at font size 14." },

  chat: { text: "The chat box." },
  "chat.lines": { text: "History lines shown in the chat." },

  style: { text: "How the overlay looks." },
  "style.fontSize": { text: "Font size. Scales the whole overlay, the icon too." },
  "style.backgroundOpacity": {
    text: "Background opacity, from 0 (none) to 1 (solid). Text stays opaque.",
  },

  ...position("the overlay", "position"),

  startup: { text: "What shows when ED Chat starts." },
  "startup.showKeys": { text: "Show the hotkey list at startup." },

  safety: { text: "Safety while flying.", playerOnly: true },
  "safety.blockWhenInDanger": { text: "Do not open the chat while the ship is in danger." },

  approval: { text: "Requests from Claude to run a tool.", playerOnly: true },
  "approval.timeoutSeconds": { text: "Seconds before a request with no answer is denied." },
  "approval.sound": { text: "Play a sound when a request arrives." },

  claude: { text: "How ED Chat starts the claude CLI.", playerOnly: true },
  "claude.path": { text: "Path to claude. null searches PATH." },
  "claude.permissionMode": {
    text: "auto: Claude runs most tools without asking. default: ask for each tool.",
  },
  "claude.extraArgs": { text: "More command-line arguments for claude." },
  "claude.resumeHours": {
    text: "Resume the last conversation when ED Chat starts within this many hours. 0 turns it off.",
  },

  journalDir: {
    text: "The game's journal folder. null uses the Saved Games folder.",
    playerOnly: true,
  },

  hud: { text: "The activity panel." },
  "hud.enabled": { text: "Show the activity panel." },
  ...position("the activity panel", "hud.position"),
  "hud.width": {
    text: "Least panel width in pixels at font size 15. The panel grows so long names fit.",
  },
  "hud.fontSize": { text: "Panel font size." },
  "hud.backgroundOpacity": { text: "Panel background opacity, from 0 (none) to 1 (solid)." },
  "hud.modes": { text: "The panel modes. false turns a mode off." },
  "hud.modes.massacre": { text: "Massacre mission kills and stacks." },
  "hud.modes.exploration": { text: "Bodies in the system worth scanning and mapping." },
  "hud.modes.exobiology": { text: "Biological samples on the planet." },
  "hud.modes.route": { text: "The stops of the current route plan." },
  "hud.valuableMin": {
    text:
      "Credits. Bodies worth less than this when mapped are left off the exploration panel. " +
      "Those with geological signals are only counted, on one line.",
  },
  "hud.spansh": {
    text:
      "Look up each system's planets on Spansh when you arrive, to show valuable worlds " +
      "before they are scanned. Only the system's ID is sent.",
  },
  "hud.bioMin": {
    text:
      "Credits. Planets with biological signals worth less than this are left off the " +
      "exploration panel. Before the species are known, a planet is judged by the least its " +
      "genera can be worth.",
  },
  "hud.edMcpDataDir": {
    text: "The ed-mcp sync folder. null finds it in the ed-mcp entry of ~/.claude.json.",
    playerOnly: true,
  },
};

export interface JsonSchemaNode {
  description?: string;
  readOnly?: boolean;
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
}

/** Adds each setting's description, and marks player-only settings readOnly. */
export function annotateSchema(node: JsonSchemaNode, where = "", playerOnly = false): void {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    if (key === "$schema") continue;
    const p = where ? `${where}.${key}` : key;
    const e = SETTINGS_DICTIONARY[p];
    const only = playerOnly || e?.playerOnly === true;
    if (e) child.description = e.playerOnly ? `${e.text} ${PLAYER_ONLY_NOTE}` : e.text;
    if (only) child.readOnly = true;
    annotateSchema(child, p, only);
  }
}
