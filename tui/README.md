# MCP Dynamics TUI

TUI de debug et d'observabilité pour le serveur MCP `mcp-dynamics`.

Elle répond à trois besoins :

1. **Lancer et surveiller** le serveur (handshake MCP, uptime, crash, exit code).
2. **Observer l'utilisation réelle** : appels d'outils, durées, erreurs, tokens, trafic — que ce soit en pilotant les appels elle-même, ou en s'intercalant en **proxy** entre un vrai client MCP (Claude Code, Claude Desktop) et le serveur.
3. **Analyser la performance** : le mode `--bench` rejoue un outil N fois et sépare le coût de l'auth `AzureCliCredential` (re-acquis à chaque requête dans `src/dataverse.ts`) de la latence Dataverse.

**Zéro dépendance runtime.** Rendu en ANSI + `readline`, aucune bibliothèque TUI
(blessed, ink, etc.) et aucun SDK MCP côté TUI : le protocole JSON-RPC sur stdio
est implémenté à la main dans `tui/mcpClient.ts`.

---

## Installation

Prérequis : **Node.js ≥ 22.6** (le type-stripping natif exécute le TypeScript
directement) et le serveur déjà buildé.

```bash
cd ~/GitHub/mcp-dynamics
npm install
npm run build          # produit dist/index.js
az login               # auth Azure CLI (voir SETUP.md)
```

Lancement :

```bash
npm run tui
```

Aucune installation supplémentaire : `package.json` n'a qu'un script `tui`
ajouté (`node --experimental-strip-types tui/index.ts`).

> **Pourquoi `--experimental-strip-types` plutôt que `tsx` ?**
> `tsx` dépend d'`esbuild`, dont le binaire natif est lié à la plateforme : un
> `node_modules` copié depuis un mac vers un Linux (fréquent en CI) casse avec
> « You installed esbuild for another platform ». Le type-stripping natif de
> Node supprime ce problème et garde la TUI sans aucune dépendance.

---

## Usage

### Modes principaux

| Commande | Effet |
|---|---|
| `npm run tui` | dashboard interactif (nécessite un TTY) |
| `npm run tui -- --tools` | liste les outils exposés puis quitte |
| `npm run tui -- --tool <n> --args '<json>'` | appel unique, affiche le résultat |
| `npm run tui -- --bench <n> --tool <n> --args '<json>'` | rejoue N fois + rapport perf |
| `npm run tui -- --watch --tool <n> --args '<json>'` | boucle continue, rapport par cycle |
| `npm run tui -- --replay <fichier.ndjson>` | analyse hors-ligne d'une session passée |
| `npm run tui -- --proxy` | s'intercale entre un client MCP et le serveur |
| `npm run tui -- --config` | affiche la config effective |
| `npm run tui -- --config benchRuns=25` | écrit `tui/tui.config.json` |
| `npm run tui -- --test` | tests de la logique pure (58 assertions) |
| `npm run tui -- --help` | aide complète |

Options courantes : `--delay <ms>` (pause entre itérations), `--timeout <ms>`,
`--server <chemin>`, `--instance <url>`, `--verbose`, `--no-log`, `--no-color`.

---

## Raccourcis clavier (dashboard)

| Touche | Action |
|---|---|
| `c` | console de requêtes |
| `t` | liste des outils (ouvre la console pré-remplie) |
| `r` | relance le serveur (nouveau handshake) |
| `e` | erreurs récentes dans une note |
| `l` | chemin du fichier log NDJSON |
| `w` | commande `watch` à utiliser pour le dernier outil appelé |
| `?` / `h` | rappel des raccourcis |
| `q` / `Ctrl+C` | quitter proprement (SIGTERM au serveur) |

Dans la console, `up` (ou `:q`, `exit`) revient au dashboard.

### Console de requêtes

Deux modes de saisie :

- **Langage naturel** — heuristique 100 % locale (`tui/nlp.ts`), sans LLM ni
  clé API. Exemple : `deals a risque du trimestre 26-Q3`. La TUI matche
  l'outil par mots-clés, extrait les arguments (`OPTY…`, GUID, emails,
  `26-Q3`, `top 5`, enums) d'après les JSON schemas de `tools/list`, puis
  **demande confirmation** (`o`ui / `n`on / `e`diter). Rien n'est exécuté à l'aveugle.
- **Formulaire** — `use <outil>` construit un formulaire à partir du
  `inputSchema` : types, champs `required`, `enum`, descriptions.

Autres commandes : `tools`, `schema <outil>`, `call <outil> '<json>'`, `? aide`.

---

## Dashboard

Rafraîchissement périodique (2 s par défaut) avec :

- état de connexion (`connecting` / `ready` / `crashed` + exit code),
- uptime, nombre d'appels, taux d'erreur, appels en vol,
- durée **moyenne / p50 / p95 / max**,
- trafic (octets) et **tokens estimés**,
- top outils (n, erreurs, moyenne, p95, octets),
- **timeline ASCII** des 50 derniers appels : histogramme vertical (chaque
  colonne = un appel) + sparkline, puis les 5 derniers appels en clair,
- erreurs récentes avec leur message, dernières lignes de stderr du serveur.

Rendu sur alternate screen. Quand `stdin` n'est pas un TTY (pipe, CI), le
dashboard est remplacé par un **REPL en ligne** lisible par un humain ou un script :

```bash
printf 'tools\ncall query_records %s\nquit\n' \
  "'{\"entity\":\"accounts\",\"top\":1}'" | npm run tui
```

---

## Analyse de performance

`src/dataverse.ts` instancie `new AzureCliCredential()` et recrée un client
axios **à chaque appel** — un token est donc ré-acquis à chaque requête
(~200-600 ms selon la machine). `--bench` rend ce coût visible :

```
npm run tui -- --bench 20 --tool get_at_risk_deals --args '{"close_quarter":"26-Q3"}'
```

Le rapport affiche min / p50 / p90 / p95 / p99 / max / moyenne, le trafic, les
échecs groupés, et surtout un **diagnostic** :

> `écart p50-min = 340ms (68%) — coût d'auth AzureCliCredential dominant`

C'est le signal qui indique qu'un cache de token (ou une réutilisation du client
axios) serait rentable. Si `p50 ≈ min`, l'auth est déjà mise en cache quelque
part et le facteur limitant est Dataverse.

`--watch` rejoue en boucle avec un rapport cumulé par cycle (`Ctrl+C` pour sortir) —
utile pour voir la dérive de latence dans la journée.

---

## Mode proxy (observabilité de l'usage réel)

Le serveur n'émet aucune métrique. Pour mesurer ce que fait **vraiment** un
client MCP, la TUI se place entre les deux et relaie tout :

```bash
# 1. dans la config MCP du client, remplacer :
#      "node /chemin/vers/dist/index.js"
#    par :
#      "node --experimental-strip-types /chemin/vers/tui/index.ts --proxy"
# 2. lancer la session normalement (les outils sont transparents)
```

- `stdout` reste le canal JSON-RPC (ne pas le rediriger),
- le dashboard s'affiche sur `stderr`,
- chaque `tools/call` est chronométré et journalisé en NDJSON.

---

## Logs NDJSON

Une session = un fichier horodaté dans `tui/logs/`
(`2026-10-02T12-40-04-086Z_proxy_358522.ndjson`). `--no-log` désactive
l'écriture. Événements : `session_start`, `server_spawn`, `rpc_request`,
`rpc_response`, `call`, `stderr`, `server_exit`, `session_end`, `error`.

Analyses hors-ligne :

```bash
npm run tui -- --replay tui/logs/2026-10-02T12-40-04-086Z_proxy_358522.ndjson
jq -r 'select(.type=="call") | "\(.record.tool) \(.record.durationMs)ms"' \
  tui/logs/*.ndjson | sort -k2 -n | tail
```

`--replay` agrège par outil, affiche la timeline, les RPC les plus lentes
(`initialize`, `tools/list`…) et **groupe les erreurs par message** — beaucoup
plus lisible qu'une liste à plat quand la même erreur revient 40 fois.

---

## Config

`tui/tui.config.json` :

| Clé | Défaut | Rôle |
|---|---|---|
| `instanceUrl` | `"auto"` | `"auto"` = détecté dans `src/dataverse.ts`, ou via `$DYNAMICS_INSTANCE_URL` |
| `serverPath` | `dist/index.js` | script du serveur |
| `serverCommand` | `node` | interpréteur |
| `serverArgs` | `[]` | arguments additionnels |
| `timeoutMs` | `30000` | timeout par requête JSON-RPC |
| `benchRuns` | `10` | itérations par défaut du `--bench` |
| `dashboardIntervalMs` | `2000` | fréquence de rafraîchissement |
| `verbose` | `false` | afficher le stderr du serveur |
| `logDir` | `tui/logs` | dossier des logs |

Surcharges ponctuelles : `--instance`, `--server`, `--timeout`, `--verbose`,
`--no-log`. Écriture : `npm run tui -- --config timeoutMs=60000 benchRuns=25`.

L'URL d'instance est lue par **regex** sur `src/dataverse.ts` plutôt qu'importée :
importer ce module exécuterait `new AzureCliCredential()` et tirerait
`@azure/identity` + `axios` dans la TUI.

---

## Exemple de session

```
$ npm run tui -- --tools
26 outils exposés par mcp-dynamics

  query_records                 Query records from any Dynamics 365 entity…
                                requis: entity
  get_forecast_summary          Get an aggregated forecast summary by quarter…
                                requis: close_quarter
  ...

$ npm run tui -- --bench 5 --tool get_at_risk_deals --args '{"close_quarter":"26-Q3"}'
bench get_at_risk_deals x5 · https://servicenow.crm.dynamics.com · timeout 30000ms

  OK [██████████░░░░░░░░░░░░░] 3/5  412ms  moy 398ms
  ...

═══ Rapport de performance ═══
  outil     : get_at_risk_deals
  itérations: 5 réussies / 0 échouées (wall 2.1s)
  durées    : min 356ms  p50 401ms  p90 428ms  p95 431ms  p99 431ms  max 431ms  moy 402ms
  analyse   : écart p50-min = 45ms (12%) — p50 proche du min : l'auth n'est pas le facteur limitant
  brut      : 356ms 401ms 412ms 401ms 431ms
```

Puis dans le dashboard interactif : `c` pour la console,
`les notes de collaboration de OPTY5331870` pour une proposition d'appel,
`e` pour voir les erreurs, `l` pour le chemin du log.

---

## Architecture

```
tui/
├── index.ts        point d'entrée : args, dispatch, shell interactif (clavier)
├── mcpClient.ts    client MCP stdio : framing newline-JSON, handshake, timeouts
├── config.ts       config + détection de l'instance dans src/dataverse.ts
├── dashboard.ts    rendu temps réel du dashboard
├── console.ts      console de requêtes (NL + formulaire)
├── nlp.ts          matching NL heuristique (aucun LLM)
├── bench.ts        --bench / --watch + rapports
├── metrics.ts      percentiles, histogramme, formatting
├── replay.ts       analyse hors-ligne des NDJSON
├── proxy.ts        mode proxy (interception d'un vrai client MCP)
├── logger.ts       écriture NDJSON de session
├── format.ts       formatage des résultats MCP
├── render.ts       helpers ANSI (écran, couleurs, blocs, sparkline)
├── prompt.ts       prompts readline
├── types.ts        types partagés
├── test-nlp.ts     tests de la logique pure (--test)
└── tui.config.json config par défaut
```

### Détails non-évidents

- **Framing stdio ≠ LSP.** `StdioServerTransport` du SDK MCP utilise du JSON
  délimité par des lignes (`JSON.stringify(msg) + "\n"`), pas des en-têtes
  `Content-Length:`. `mcpClient.ts` bufferise puis découpe sur `\n`.
- **Ordre du handshake imposé.** `initialize` doit être le premier message ; le
  serveur refuse `tools/list` avant `notifications/initialized`.
- **`stdout` est réservé au protocole.** Tout log du serveur passe par `stderr`
  (c'est aussi pourquoi le dashboard du mode proxy est sur `stderr`).
- **Erreurs applicatives ≠ erreurs JSON-RPC.** `records.ts` renvoie une
  `McpError`, donc l'erreur arrive en `error` JSON-RPC. Mais la spec autorise
  aussi `result` avec `isError: true` : les deux cas sont traités.
- **`id` JSON-RCP.** Le client interne n'accepte que des ids numériques (comme
  le SDK officiel). Le mode proxy alloue un id interne et restaure l'id d'origine
  dans la réponse.
- **Pas de parameter properties.** Le mode strip-only de Node refuse
  `constructor(private x: T)` : tous les champs sont déclarés explicitement.
- **Tokens estimés.** Le transport stdio ne transporte aucune métrique de tokens
  ; l'estimation utilise ~4 caractères/token. Suffisant pour comparer des
  scénarios, pas pour de la facturation.

---

## Vérification

```bash
npm run typecheck        # src/  — aucune erreur
npm run tui:typecheck    # tui/  — aucune erreur
npm run tui:test         # 58 assertions : metrics, NLP, ANSI, formatage
```

`src/` n'est jamais modifié par la TUI : le type-check de `tui/` utilise son
propre `tui/tsconfig.json` (`noEmit`, `allowImportingTsExtensions`) pour ne pas
perturber le `rootDir` du build principal.