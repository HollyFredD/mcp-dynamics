# MCP Dynamics 365 — Guide de configuration

Serveur MCP local connectant Claude à Microsoft Dynamics 365 (Dataverse) via l'authentification Azure CLI (SSO ServiceNow/Okta). Aucun App Registration Azure AD requis.

---

## Prérequis

- Node.js 18+
- Azure CLI (`brew install azure-cli`)
- Accès Dynamics 365 : `https://servicenow.crm.dynamics.com`

---

## 1. Build du serveur

```bash
cd ~/Claude/mcp-dynamics
npm install
npm run build
# Produit : dist/index.js
```

---

## 2. Authentification Azure

Une seule fois (le token est mis en cache et renouvelé automatiquement) :

```bash
az login
# Suivre le flow SSO — choisir le compte @servicenow.com
```

Vérifier que le bon tenant est actif :

```bash
az account show --query "{tenant:tenantDisplayName, user:user.name}"
# Attendu : ServiceNow / frederic.farjon@servicenow.com
```

---

## 3. Configuration dans Claude Code (CLI)

```bash
claude mcp add dynamics --scope user -- node /Users/frederic.farjon/Claude/mcp-dynamics/dist/index.js
```

Le flag `--scope user` enregistre le serveur pour tous les projets (stocké dans `~/.claude.json`).

Vérifier que le serveur est actif :

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
```

Ajouter la section `mcpServers` :

```json
{
  "mcpServers": {
    "dynamics": {
      "command": "node",
      "args": ["/Users/frederic.farjon/Claude/mcp-dynamics/dist/index.js"]
    }
  }
}
```

Redémarrer Claude Desktop. Les outils `dynamics__*` apparaissent dans l'interface.

> Claude Desktop hérite des credentials Azure CLI du shell. Si les outils échouent avec une erreur d'auth, ouvrir un terminal et relancer `az login`.

---

## Outils disponibles

| Outil | Description |
|---|---|
| `query_records` | Requête OData ou FetchXML sur n'importe quelle entité |
| `get_record` | Récupère un enregistrement par GUID |
| `create_record` | Crée un enregistrement |
| `update_record` | Met à jour des champs |
| `delete_record` | Supprime un enregistrement |
| `get_entity_metadata` | Schéma d'une entité |
| `list_entities` | Liste toutes les entités disponibles |

Exemple — récupérer une opportunité par numéro :

```
query_records(
  entity: "opportunities",
  filter: "sn_number eq 'OPTY5331870'",
  select: "sn_number,name,sn_netnewacv,estimatedclosedate,sn_probability"
)
```

---

## Dépannage

**Les outils n'apparaissent pas après configuration**
Redémarrer complètement Claude Code ou Claude Desktop.

**Erreur `DefaultAzureCredential` ou 401**
Le token Azure a expiré ou n'existe pas. Relancer `az login`.

**Erreur de compilation TypeScript**
```bash
npm run build 2>&1
# Vérifier les erreurs dans src/
```
