import { localDay, olderVersion, type SavedSession } from "../game/saves";

export function formatSaveDate(timestamp?: number): string {
  if (timestamp === undefined) return "Save data is damaged.";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Invalid save date.";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${localDay(timestamp)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Startup picker: the user must choose a session or start a new one. */
export class SessionPicker {
  private readonly root = document.createElement("section");
  private readonly list = document.createElement("div");
  private readonly error = document.createElement("p");
  private readonly newButton = document.createElement("button");
  private cancelDelete?: () => void;
  private deleteRow?: HTMLElement;

  constructor(
    private readonly load: (id: string) => boolean,
    private readonly remove: (id: string) => SavedSession[] | undefined,
    private readonly startNew: () => void,
  ) {
    this.root.className = "statistics";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "sessions-title");
    this.root.addEventListener("pointerdown", (event) => {
      if (this.deleteRow && event.target instanceof Node && !this.deleteRow.contains(event.target)) this.cancelDelete?.();
    });
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.cancelDelete) {
        event.stopPropagation();
        this.cancelDelete();
      }
    });
    const panel = document.createElement("div");
    panel.className = "statistics-panel sessions-panel";
    const title = document.createElement("h1");
    title.id = "sessions-title";
    title.textContent = "Choose a session";
    this.list.className = "sessions-list";
    this.error.className = "sessions-error";
    this.error.setAttribute("role", "alert");
    this.newButton.type = "button";
    this.newButton.textContent = "Start a new game";
    this.newButton.addEventListener("click", () => {
      this.startNew();
      this.close();
    });
    panel.append(title, this.list, this.error, this.newButton);
    this.root.append(panel);
    document.body.append(this.root);
  }

  get open(): boolean { return !this.root.hidden; }

  show(sessions: SavedSession[], error = ""): void {
    this.cancelDelete?.();
    this.error.textContent = error;
    this.list.replaceChildren();
    for (const session of sessions) {
      const row = document.createElement("div");
      row.className = "sessions-row";
      const details = document.createElement("div");
      details.className = "sessions-details";
      const heading = document.createElement("strong");
      heading.textContent = session.damaged ? "Unreadable session" : session.name ?? session.id;
      const progress = document.createElement("div");
      if (!session.damaged) progress.textContent = `Epoch ${session.epoch} - ${session.score} deliveries`;
      const date = document.createElement("div");
      date.textContent = formatSaveDate(session.updatedAt);
      details.append(heading, progress, date);
      const preview = document.createElement("div");
      preview.className = "sessions-preview";
      if (session.thumbnail) {
        const image = document.createElement("img");
        image.src = session.thumbnail;
        image.alt = `Game viewport for ${session.name}`;
        image.width = image.height = 128;
        preview.append(image);
      } else {
        preview.textContent = "No snapshot yet";
      }
      if (session.version && olderVersion(session.version)) {
        const warning = document.createElement("div");
        warning.className = "sessions-warning";
        warning.textContent = `Saved with version ${session.version}; it may be incompatible.`;
        details.append(warning);
      }
      const buttons = document.createElement("div");
      buttons.className = "sessions-actions";
      const load = document.createElement("button");
      load.type = "button";
      load.textContent = "Load";
      load.disabled = session.damaged;
      load.addEventListener("click", () => {
        if (this.load(session.id)) this.close();
        else this.error.textContent = "Could not load this session. It may be incompatible or damaged.";
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete ${heading.textContent}`);
      const confirmation = document.createElement("div");
      confirmation.className = "sessions-confirm";
      confirmation.hidden = true;
      confirmation.setAttribute("role", "group");
      confirmation.setAttribute("aria-label", "Confirm session deletion");
      const question = document.createElement("span");
      question.textContent = "Delete this saved session?";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.textContent = "Delete";
      confirm.className = "sessions-confirm-delete";
      cancel.addEventListener("click", () => {
        this.cancelDelete?.();
        remove.focus();
      });
      confirm.addEventListener("click", () => {
        const updated = this.remove(session.id);
        if (updated) this.show(updated);
        else {
          this.cancelDelete?.();
          this.error.textContent = "Could not delete the session. Check browser storage permissions.";
        }
      });
      confirmation.append(question, cancel, confirm);
      remove.addEventListener("click", () => {
        this.cancelDelete?.();
        confirmation.hidden = false;
        remove.hidden = true;
        load.disabled = true;
        this.deleteRow = row;
        this.cancelDelete = () => {
          const restoreFocus = document.activeElement === cancel || document.activeElement === confirm;
          confirmation.hidden = true;
          remove.hidden = false;
          load.disabled = session.damaged;
          this.deleteRow = undefined;
          this.cancelDelete = undefined;
          if (restoreFocus) remove.focus();
        };
        cancel.focus();
      });
      buttons.append(load, remove);
      row.append(preview, details, buttons, confirmation);
      this.list.append(row);
    }
    this.root.hidden = false;
    requestAnimationFrame(() => { if (this.open) this.root.classList.add("statistics-visible"); });
    this.newButton.focus();
  }

  private close(): void {
    this.cancelDelete?.();
    this.root.classList.remove("statistics-visible");
    this.root.hidden = true;
  }
}
