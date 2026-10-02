import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Racine du dossier `tui/` (dossier du fichier courant). */
export const TUI_DIR = dirname(fileURLToPath(import.meta.url));
/** Racine du dépôt (= dossier parent de `tui/`). */
export const REPO_ROOT = resolve(TUI_DIR, "..");
export const CONFIG_PATH = join(TUI_DIR, "tui.config.json");
export const LOG_DIR = join(TUI_DIR, "logs");

export interface TuiConfig {
  /**
   * URL de l'instance Dataverse. Valeur sentinelle "auto" => on la détecte dans
   * src/dataverse.ts (regex sur la constante INSTANCE_URL). Utile car le serveur
   * a cette URL en dur et l'auth Azure dépend du tenant correspondant.
   */
  instanceUrl: string;
  /** Chemin du binaire JS du serveur MCP (relatif au dépôt ou absolu). */
  serverPath: string;
  /** Commande utilisée pour lancer le serveur. */
  serverCommand: string;
  /** Arguments additionnels passés au serveur (avant le chemin du script). */
  serverArgs: string[];
  /** Timeout (ms) par requête JSON-RPC (initialize, tools/list, tools/call). */
  timeoutMs: number;
  /** Nombre d'itérations par défaut du mode `--bench`. */
  benchRuns: number;
  /** Intervalle de rafraîchissement du dashboard (ms). */
  dashboardIntervalMs: number;
  /** Verbosité : logs stderr du serveur affichés dans le dashboard + NDJSON détaillé. */
  verbose: boolean;
  /** Dossier des logs NDJSON. */
  logDir: string;
}

export const DEFAULT_CONFIG: TuiConfig = {
  instanceUrl: "auto",
  serverPath: join("dist", "index.js"),
  serverCommand: "node",
  serverArgs: [],
  timeoutMs: 30_000,
  benchRuns: 10,
  dashboardIntervalMs: 2_000,
  verbose: false,
  logDir: LOG_DIR,
};

export interface LoadedConfig {
  config: TuiConfig;
  /** Chemin du fichier de config lu (undefined si absent). */
  path?: string;
  /** URL de l'instance effectivement utilisée. */
  instanceUrl: string;
  /** Comment on a obtenu l'URL : "config" | "dataverse.ts" | "default" | "flag". */
  instanceSource: string;
  /** Chemin absolu du script serveur. */
  serverPath: string;
  /** true si le script serveur existe sur le disque. */
  serverExists: boolean;
}

function toAbsolute(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

/**
 * Détecte l'URL d'instance dans src/dataverse.ts sans l'importer.
 *
 * Pourquoi ne pas `import` ? Importer src/dataverse.ts exécuterait
 * `new AzureCliCredential()` et tirerait @azure/identity + axios dans la TUI ;
 * on veut seulement lire une constante. Une regex sur le source suffit et ne
 * casse jamais le typage du dépôt.
 *
 * On cherche la première URL d'instance (`.crm.dynamics.com`) présente dans le
 * fichier, que la constante soit écrite en dur ou via un `?? "..."` avec une
 * variable d'environnement (`DYNAMICS_INSTANCE_URL`).
 */
export function detectInstanceUrl(): string | null {
  const file = join(REPO_ROOT, "src", "dataverse.ts");
  if (!existsSync(file)) return null;
  const src = readFileSync(file, "utf8");
  const m = src.match(/https:\/\/[a-zA-Z0-9-]+\.crm\.dynamics\.com/);
  return m ? m[0] : null;
}

/** Lit la config en fusionnant : defaults < tui.config.json < overrides. */
export function loadConfig(overrides: Partial<TuiConfig> = {}): LoadedConfig {
  let fromFile: Partial<TuiConfig> = {};
  let path: string | undefined;
  if (existsSync(CONFIG_PATH)) {
    path = CONFIG_PATH;
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<TuiConfig>;
    } catch (err) {
      // Un fichier de config corrompu ne doit pas empêcher la TUI de démarrer.
      process.stderr.write(
        `[tui] config illisible (${CONFIG_PATH}): ${(err as Error).message}\n`
      );
      fromFile = {};
    }
  }

  const config: TuiConfig = { ...DEFAULT_CONFIG, ...fromFile, ...overrides };

  let instanceUrl = config.instanceUrl;
  let instanceSource = "config";
  if (!instanceUrl || instanceUrl === "auto") {
    // Le serveur peut surcharger l'instance via une variable d'environnement
    // (cf. src/dataverse.ts : process.env.DYNAMICS_INSTANCE_URL). Si elle est
    // posée, c'est elle qui fait foi — on l'affiche donc comme telle.
    const fromEnv = process.env.DYNAMICS_INSTANCE_URL;
    const detected = fromEnv ?? detectInstanceUrl();
    if (detected) {
      instanceUrl = detected;
      instanceSource = fromEnv ? "DYNAMICS_INSTANCE_URL" : "dataverse.ts";
    } else {
      instanceUrl = "https://<instance>.crm.dynamics.com";
      instanceSource = "default";
    }
  }

  const serverPath = toAbsolute(config.serverPath, REPO_ROOT);
  // Un logDir vide (--no-log) est conservé tel quel ; sinon on résout les
  // chemins relatifs depuis la racine du dépôt pour être indépendant du cwd.
  const logDir = config.logDir ? toAbsolute(config.logDir, REPO_ROOT) : "";
  return {
    config: { ...config, logDir },
    path,
    instanceUrl,
    instanceSource,
    serverPath,
    serverExists: existsSync(serverPath),
  };
}

/** Écrit la config sur disque (pretty-print, 2 espaces, comme le reste du repo). */
export function saveConfig(config: TuiConfig): string {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return CONFIG_PATH;
}

/** Extrait le tenant attendu de l'URL — sert aux messages d'erreur d'auth. */
export function tenantFromInstanceUrl(url: string): string | null {
  const m = url.match(/https:\/\/([^.]+)\.crm\.dynamics\.com/);
  return m ? m[1] : null;
}