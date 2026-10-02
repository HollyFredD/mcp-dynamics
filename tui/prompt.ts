import { createInterface, type Interface } from "node:readline";

/**
 * Wrapper readline : prompt lisible + historique, sans dépendance.
 * Le résultat est une promesse ; une entrée vide accepte la valeur par défaut.
 */
export class Prompter {
  private rl: Interface | null = null;
  private readonly input: NodeJS.ReadableStream;

  // Champ explicite (pas de "parameter property") pour rester compatible avec
  // le mode strip-only de Node.
  constructor(input: NodeJS.ReadableStream = process.stdin) {
    this.input = input;
  }

  private ensure(): Interface {
    if (!this.rl) {
      this.rl = createInterface({
        input: this.input,
        // On écrit sur stderr : en mode proxy stdout est réservé au protocole.
        output: process.stderr,
        terminal: Boolean((process.stdin as NodeJS.ReadStream).isTTY),
      });
    }
    return this.rl;
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
    const answer = await this.askRaw(`${question}${suffix}: `);
    return answer.trim() === "" && defaultValue !== undefined ? defaultValue : answer.trim();
  }

  /** Ask sans prompt visible (pour lire du JSON/choix). */
  async askRaw(promptText: string): Promise<string> {
    const rl = this.ensure();
    return new Promise((resolve) => rl.question(promptText, resolve));
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }

  /** Ouvre stdin en mode « une ligne à la fois » sans prompt (mode pipe). */
  static isInteractive(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }
}