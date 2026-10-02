# MCP Dynamics 365 — Guide de configuration

Serveur MCP local connectant Claude à Microsoft Dynamics 365 (Dataverse) via l'authentification **Azure CLI** (`AzureCliCredential`, SSO ServiceNow/Okta). Aucun App Registration Azure AD requis.

---

## Prérequis

- Node.js 18.17+
- Azure CLI (`brew install azure-cli`)
- Accès Dynamics 365 : `https://servicenow.crm.dynamics.com` (ou votre propre environnement, voir §5)

---

## 1. Build du serveur

```bash
cd /chemin/vers/mcp-dynamics
npm install
npm run build          # produit dist/index.js
npm run health-check   # vérifie que le serveur répond au handshake MCP
```

> ⚠️ Il n'existe pas de commande `npm test` : le dépôt n'a aucun test.
> `npm run health-check` lance le serveur, envoie `initialize` + `tools/list` sur son stdin et affiche les 26 outils. C'est le vrai smoke test.

---

## 2. Authentification Azure

Une seule fois (le token est mis en cache ~50 min et renouvelé automatiquement avec 60 s de marge ; un 401 invalide le cache et rejoue la requête une fois) :

```bash
az login
# Suivre le flow SSO — choisir le compte @servicenow.com
```

Vérifier que le bon tenant est actif :

```bash
az account show --query "{tenant:tenantDisplayName, user:user.name}"
# Attendu : ServiceNow / frederic.farjon@servicenow.com
```

Le serveur utilise `AzureCliCredential` — **pas** `DefaultAzureCredential`. Si vous voyez `DefaultAzureCredential` dans une erreur, c'est une ancienne version du code : `az login` reste la bonne action.

---

## 3. Configuration dans Claude Code (CLI)

> **Le transport stdio n'est pas un daemon.** Le client MCP spawn `dist/index.js`,
> parle sur stdin/stdout, et le process meurt avec le client. C'est le mode par
> défaut, et le plus simple. Pour un service qui doit tourner en arrière-plan,
> voir « Mode serveur (Streamable HTTP) » plus bas ou [`deploy/README.md`](deploy/README.md).

```bash
claude mcp add dynamics --scope user -- node /chemin/vers/mcp-dynamics/dist/index.js
```

Le flag `--scope user` enregistre le serveur pour tous les projets (stocké dans `~/.claude.json`).

```bash
claude mcp list
# dynamics: node .../dist/index.js - ✔ Connected
```

Redémarrer Claude Code pour que les outils apparaissent dans la session.

---

## 4. Configuration dans Claude Desktop

Ouvrir le fichier de configuration Claude Desktop :

```bash
# macOS
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
# Linux
xdg-open ~/.config/Claude/claude_desktop_config.json
```

```json
{
  "mcpServers": {
    "dynamics": {
      "command": "node",
      "args": ["/chemin/vers/mcp-dynamics/dist/index.js"],
      "env": {
        "DYNAMICS_INSTANCE_URL": "https://servicenow.crm.dynamics.com"
      }
    }
  }
}
```

Redémarrer Claude Desktop. Les outils `dynamics__*` apparaissent dans l'interface.

> Claude Desktop hérite des credentials Azure CLI du shell. Si les outils échouent avec une erreur d'auth, ouvrir un terminal et relancer `az login`.

---

## 5. Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `DYNAMICS_INSTANCE_URL` | `https://servicenow.crm.dynamics.com` | URL de l'environnement Dataverse. **À changer pour un autre tenant.** |
| `DYNAMICS_API_VERSION` | `v9.2` | Version de l'API WebDAV/OData |
| `MCP_DYNAMICS_READONLY` | *(non défini)* | `1` = **toutes les écritures sont refusées** avec un message explicite |
| `MCP_DYNAMICS_ALLOWED_ENTITIES` | *(vide = tout)* | Liste blanche d'entités séparées par des virgules, ex. `opportunities,accounts,sn_specialistforecasts` |
| `MCP_DYNAMICS_TRANSPORT` | *(déduit)* | `http` en mode serveur. Utilisé pour activer le read-only par défaut. |
| `MCP_DYNAMICS_HTTP_TOKEN` | — | **Obligatoire en HTTP.** Bearer token. Sans lui le serveur refuse de démarrer. |
| `MCP_DYNAMICS_HTTP_HOST` | `127.0.0.1` | Interface d'écoute du serveur HTTP. |
| `MCP_DYNAMICS_HTTP_PORT` | `3000` | Port d'écoute. |
| `MCP_DYNAMICS_HTTP_RATE` | `120` | Requêtes/minute/IP. |

`MCP_DYNAMICS_READONLY` est volontairement strict : en HTTP il vaut `1` par
défaut, et **seul `0` le désactive** — `foo`, `true` ou une chaîne vide
l'activent. Un shell qui veut écrire doit le dire explicitement.

Exemple en lecture seule (revue de forecast sans risque de modification) :

```json
"env": { "MCP_DYNAMICS_READONLY": "1" }
```

---

## 6. Mode serveur (Streamable HTTP)

Le mode stdio ne peut pas tourner en arrière-plan. Pour un service persistant :

```bash
npm run build
export MCP_DYNAMICS_HTTP_TOKEN=$(openssl rand -hex 32)
npm run start:http              # écoute sur 127.0.0.1:3000
```

Côté client, on remplace la commande par une URL :

```jsonc
{
  "mcpServers": {
    "dynamics": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer <le-token>" }
    }
  }
}
```

Le read-only est **actif par défaut** sur ce transport : le serveur agit avec
l'identité Azure CLI du compte qui a lancé `az login`, donc quiconque atteint le
port lit — et potentiellement écrit — votre pipeline.

Installation en service (systemd), durcissement, TLS et tunnel SSH :
[`deploy/README.md`](deploy/README.md).

Vérification : `npm run health-check:http` (8 contrôles, démarre le serveur si
besoin).

## Outils disponibles (26)

### Découverte de schéma — à utiliser avant d'écrire

| Outil | Description |
|---|---|
| `describe_entity_fields` | Liste les attributs d'une entité (nom, label, type, custom / read-only / calculé / requis). **Le levier n°1 de fiabilité** : ne devinez plus les noms de champs. Filtrez avec `search` (`'acv'`, `'probab'`, `'renewal'`…). |
| `list_picklist_values` | Décode les codes d'un picklist (win/loss reasons, risk types, sales stages, forecast categories). |
| `get_entity_metadata` | Clé primaire, champ nom, label d'une entité. |
| `list_entities` | Liste **bornée à 200** des entités, triée par LogicalName, avec `has_more`. |

### CRUD générique

| Outil | Description |
|---|---|
| `query_records` | Requête OData **ou** FetchXML. `include_annotations`, `fetch_all`, `max_pages`, `max_rows`. Retourne toujours `truncated` / `has_more` / `total_count`. |
| `get_record` | Enregistrement par GUID. |
| `create_record` | Création — **dry run par défaut**, liste d'écriture restreinte. |
| `update_record` | Mise à jour — **dry run par défaut**, relue et vérifiée champ par champ après écriture. |
| `delete_record` | Suppression — exige `confirm: true`, liste d'interdiction stricte. |
| `aggregate_query` | Agrégation serveur (`sum`/`avg`/`min`/`max`/`count`) avec `groupby`. Ne plafonne pas à 500 lignes. |

### Opportunités & pipeline

| Outil | Description |
|---|---|
| `get_my_opportunities` | Opportunités par rôle (owner, field sales rep, solution consultant, secondary sales rep, **renewal account manager**). Filtres : statut, catégorie, trimestre. |
| `search_opportunities` | Recherche par nom d'opportunité **ou** de compte (requête unique, sémantique identique). `returned` / `total_found` / `has_more`. |
| `get_opportunity_products` | Lignes produit (SKUs). GUID ou numéro (`OPTY5331870`). |
| `add_opportunity_product` | Ajoute une ligne + sous-produit. **Idempotent**, pourcentage calculé sur le reste disponible, parent recalculé, rollback si le sous-produit échoue. |
| `get_collaboration_notes` | Notes de collaboration, triées du plus récent au plus ancien. |
| `add_collaboration_note` | Ajoute une note (Next Steps / Win-Loss / General). Sujet tronqué à 100 caractères. |

### Forecast

| Outil | Description |
|---|---|
| `get_specialist_opportunities` | Lignes `sn_specialistforecast` d'un spécialiste, **ouvertes par défaut** (cohérent avec `get_forecast_summary`). |
| `get_forecast_summary` | Agrégat par trimestre : ACV et deals par catégorie et par BU. Pagination suivie → **les totaux ne sont jamais plafonnés silencieusement**. |
| `get_forecast_integrity` | Contrôle qualité du forecast call : compare les colonnes opérationnelles et reporting (catégorie et ACV) et renvoie les écarts avec le delta. |
| `get_team_forecast` | Rollup manager : ACV par rep, concentration (part du top 3, HHI), reps sans aucune prévision. |
| `get_at_risk_deals` | Deals en retard / stale / mal alignés. **Couvre les 5 rôles** et utilise `closeprobability` (numérique). |
| `get_closing_readiness` | Checklist de clôture ServiceNow (~150 champs booléens) en 5 groupes, `blocking_items`, verdict `ready_to_close` / `at_risk` / `early_stage`. |
| `get_quarter_context` | Normalise `26-Q3` / `2026-Q3` / `26Q3` / `Q3-26` et donne bornes, position dans le temps, trimestre précédent/suivant. |
| `update_opportunity_forecast` | Catégorie / close date / close quarter. Recalcule le trimestre si seule la date change. |
| `update_specialist_forecast` | Catégorie au niveau spécialiste. Refuse les matchs ambigus (>1 BU) sans `confirm`. |

### Observabilité

| Outil | Description |
|---|---|
| `get_recent_tool_calls` | « Qu'est-ce que tu viens de faire sur mon pipeline ? » — un enregistrement par appel d'outil (durée, succès, erreur, lignes, appels Dataverse). |

---

## Pièges métier importants

- **`sn_probability` est CALCULÉ** et de type **chaîne** (`"100%"`). On ne l'écrit jamais et on ne filtre jamais dessus. La probabilité numérique est **`closeprobability`** (entier 0-100).
- `sn_netnewacv` est en **devise locale**. Pour comparer entre devises, utilisez `sn_netnewacv_base`.
- **Deux niveaux de forecast** : `opportunities.sn_forecastcategory` et `sn_specialistforecasts.sn_specialistforecastcategory`. Ils peuvent divergir — c'est ce que vérifie `get_forecast_integrity`.
- `forecast_category` accepte `pipeline | best_case | committed | upside | closed`. **`won` n'est pas une catégorie de forecast** : le gagné/perdu est dans `statecode` (0 open, 1 won, 2 lost).
- Une ligne `sn_specialistforecast` **n'est pas** une ligne produit (`opportunityproducts`).
- Toujours préciser le trimestre au format **`26-Q3`**.
- Tous les outils mutants sont en **dry run par défaut** : ils renvoient le diff exact. Passez `dry_run: false` pour écrire.

Exemple — récupérer une opportunité par numéro (`select` est un **tableau**) :

```
query_records(
  entity: "opportunities",
  filter: "sn_number eq 'OPTY5331870'",
  select: ["sn_number", "name", "sn_netnewacv", "sn_currencycode", "estimatedclosedate", "closeprobability", "sn_forecastcategory", "statecode"]
)
```

Mieux, pour décider quoi écrire :

```
describe_entity_fields(entity: "opportunities", search: "acv")
list_picklist_values(entity: "opportunities", attribute: "sn_winlossnodecisionreason")
```

---

## Dépannage

**Les outils n'apparaissent pas après configuration**
Redémarrer complètement Claude Code ou Claude Desktop.

**401 / « no token »**
Le token Azure est absent ou expiré. `az login`. Le serveur invalide automatiquement le cache sur un 401 et rejoue la requête une fois — si l'erreur persiste, c'est que `az login` n'a pas été fait dans le bon terminal.

**403**
Rôle de sécurité insuffisant sur l'entité ou l'opération. Demander un rôle à l'administrateur Dataverse. L'erreur affichée est `Dataverse HTTP 403 — …` avec le hint correspondant.

**429 / throttling**
Dataverse limite le débit. Le serveur réessaie automatiquement (jusqu'à 4 fois, backoff exponentiel + jitter, en respectant `Retry-After`). Si ça persiste, réduisez `top` et utilisez `aggregate_query` au lieu de télécharger des lignes.

**Timeout**
Lecture : 30 s. Écriture : 120 s (les plugins Dataverse sont lents). Au-delà, l'erreur est `Dataverse HTTP network (timeout)`.

**« total_issues » et « distinct_deals » diffèrent**
Normal : un deal peut être en retard ET stale ET mal aligné. `total_issues` compte les **lignes**, `distinct_deals` les **deals uniques**.

**Les totaux semble incomplets**
Vérifiez `truncated` / `has_more` dans la réponse. Si `truncated: true`, relancez avec `fetch_all: true` (ou `max_pages` plus élevé) ou passez par `aggregate_query`.

**Erreur de compilation TypeScript**
```bash
npm run typecheck
```

---

## Dépannage avancé — logs

Le serveur écrit **uniquement sur stderr** (stdout porte le protocole JSON-RPC et n'est jamais pollué), une ligne JSON par événement :

```json
{"event":"server_started","tools":26,"environment":{...}}
{"event":"tool_call","ts":"...","tool":"get_forecast_summary","duration_ms":812,"ok":true,"rows":143,"dataverse_calls":3}
{"event":"mutation","action":"update_opportunity_forecast","opportunity":"OPTY5331870",...}
{"event":"dataverse_retry","status":429,"attempt":1,"delay_ms":743}
```

Pour les voir dans Claude Desktop, consulter le fichier de log de l'application. Dans Claude Code, ils apparaissent dans la sortie du serveur MCP.

`get_recent_tool_calls` expose les mêmes informations en mémoire, sans passer par les fichiers.