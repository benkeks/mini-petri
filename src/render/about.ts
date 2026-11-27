import { version } from "../../package.json";

/** About dialog with the same transitions and dismissal behavior as statistics. */
export class AboutScreen {
  private readonly root = document.createElement("section");
  private readonly closeButton = document.createElement("button");
  private previousFocus?: HTMLElement;
  private hideTimer?: number;
  private showFrame?: number;
  private backdropPointer?: number;
  private isOpen = false;

  constructor(private readonly onClose: () => void) {
    this.root.className = "statistics about";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "about-title");
    this.root.addEventListener("pointerdown", (event) => {
      if (event.target === this.root && event.button === 0) this.backdropPointer = event.pointerId;
    });
    this.root.addEventListener("pointerup", (event) => {
      if (event.pointerId === this.backdropPointer && event.target === this.root) this.close();
      this.backdropPointer = undefined;
    });
    this.root.addEventListener("pointercancel", () => { this.backdropPointer = undefined; });
    const panel = document.createElement("div");
    panel.className = "statistics-panel about-panel";
    const header = document.createElement("header");
    const title = document.createElement("h1");
    title.id = "about-title";
    title.textContent = "About Mini Petri";
    this.closeButton.type = "button";
    this.closeButton.textContent = "Close";
    this.closeButton.addEventListener("click", () => this.close());
    header.append(title, this.closeButton);
    const content = document.createElement("div");
    content.className = "about-content";
    const versionLine = document.createElement("p");
    versionLine.textContent = `Mini Petri v${version}`;
    content.append(versionLine);
    const description = document.createElement("p");
    description.textContent = "A game about colored Petri nets.";
    content.append(description);
    const author = document.createElement("p");
    author.append("Developed by benkeks / ");
    const email = document.createElement("a");
    email.href = "mailto:benjamin.bisping@centralesupelec.fr";
    email.textContent = "benjamin.bisping@centralesupelec.fr";
    author.append(email);
    content.append(author);
    const source = document.createElement("p");
    const sourceLink = document.createElement("a");
    sourceLink.href = "https://github.com/benkeks/mini-petri";
    sourceLink.textContent = "GitHub source";
    sourceLink.target = "_blank";
    sourceLink.rel = "noopener noreferrer";
    source.append(sourceLink);
    content.append(source);
    const reports = document.createElement("p");
    reports.append("Please send bug reports and feedback from playing via ");
    const issues = document.createElement("a");
    issues.href = "https://github.com/benkeks/mini-petri/issues";
    issues.textContent = "GitHub issues";
    issues.target = "_blank";
    issues.rel = "noopener noreferrer";
    reports.append(issues, " or email.");
    content.append(reports);
    const thanks = document.createElement("p");
    thanks.textContent = "Thanks to our testers:";
    const testers = document.createElement("ul");
    for (const name of ["Niko", "Aljoscha"]) {
      const tester = document.createElement("li");
      tester.textContent = name;
      testers.append(tester);
    }
    content.append(thanks, testers);
    panel.append(header, content);
    this.root.append(panel);
    document.body.append(this.root);
  }

  get open(): boolean {
    return this.isOpen;
  }

  show(): void {
    if (this.open) return;
    this.isOpen = true;
    window.clearTimeout(this.hideTimer);
    if (this.showFrame !== undefined) window.cancelAnimationFrame(this.showFrame);
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.root.hidden = false;
    this.showFrame = window.requestAnimationFrame(() => {
      this.root.classList.add("statistics-visible");
      this.showFrame = undefined;
    });
    this.closeButton.focus();
  }

  close(): void {
    if (!this.open) return;
    this.isOpen = false;
    this.backdropPointer = undefined;
    if (this.showFrame !== undefined) window.cancelAnimationFrame(this.showFrame);
    this.showFrame = undefined;
    this.root.classList.remove("statistics-visible");
    this.hideTimer = window.setTimeout(() => { this.root.hidden = true; }, 180);
    this.onClose();
    this.previousFocus?.focus();
    this.previousFocus = undefined;
  }
}
