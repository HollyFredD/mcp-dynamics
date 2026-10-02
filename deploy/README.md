# Deployment HTTP — mcp-dynamics

## Prérequis

- Node.js ≥ 18.17
- `az login` effectué **sous l'utilisateur qui lance le service** (c'est lui qui
  porte l'identité : voir « Sécurité » plus bas)
- `npm run build`

## 1. Lancer en local d'abord

```bash
npm run build
export MCP_DYNAMICS_HTTP_TOKEN=$(openssl rand -hex 32)
npm run start:http
```

Vérification :

```bash
curl -s localhost:3000/healthz | jq
npm run health-check:http    # 8 vérifications, démarre le serveur si besoin
```

C'est le mode « foreground », pratique pour lire les logs. Pour un vrai
daemon (start/stop/status), voir §2.

## 2. Gestion en local : `mcp-ctl.sh`

En développement, pas besoin de systemd — le script root `mcp-ctl.sh` (ou
`npm run ctl -- <cmd>`) pilote le daemon :

```bash
./mcp-ctl.sh start      # build si besoin, génère ./.env.http + un token, attend /healthz
./mcp-ctl.sh status     # PID, uptime, outils, sessions, read-only, instance
./mcp-ctl.sh logs -f    # NDJSON du serveur
./mcp-ctl.sh restart
./mcp-ctl.sh stop       # SIGTERM, puis SIGKILL après 10 s
./mcp-ctl.sh token      # le Bearer token à copier côté client
```

| Où | Quoi |
|---|---|
| `.env.http` | config + token, mode 600, gitignoré (`.env.*`), créé au 1er `start` |
| `logs/http.log` | sortie stderr du daemon |
| `$XDG_RUNTIME_DIR/mcp-dynamics/mcp-dynamics.pid` | PID ( `/tmp/...` si `XDG_RUNTIME_DIR` absent) |

`start` refuse de démarrer si le port est déjà occupé, si le serveur ne
répond pas sur `/healthz` sous 10 s (il affiche alors le log), ou si le
service systemd `mcp-dynamics` est déjà actif. `status` renvoie 3 si le
serveur est arrêté, 4 s'il est vivant mais ne répond plus — exploitable
en supervision.

## 3. Service systemd

```bash
sudo cp deploy/mcp-dynamics.service /etc/systemd/system/
sudo sed -i "s|YOUR_USER|$USER|g" /etc/systemd/system/mcp-dynamics.service

# Le token hors du fichier de service, en root-only
sudo install -d -m 700 /etc/mcp-dynamics
openssl rand -hex 32 | sudo tee /etc/mcp-dynamics/token >/dev/null
echo "MCP_DYNAMICS_HTTP_TOKEN=$(sudo cat /etc/mcp-dynamics/token)" \
  | sudo tee /etc/mcp-dynamics/env >/dev/null
sudo chmod 600 /etc/mcp-dynamics/env

sudo systemctl daemon-reload
sudo systemctl enable --now mcp-dynamics
sudo systemctl status mcp-dynamics
journalctl -u mcp-dynamics -f
```

Récupérer le token pour le client MCP :

```bash
sudo cat /etc/mcp-dynamics/token
```

## 4. Connecter Claude

`~/.claude.json` (Claude Code) ou `claude_desktop_config.json` :

```jsonc
{
  "mcpServers": {
    "dynamics": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer <coller-le-token-ici>" }
    }
  }
}
```

Sans en-têtes, sur le mode stdio uniquement :

```jsonc
{ "mcpServers": { "dynamics": {
  "command": "node",
  "args": ["/home/<user>/GitHub/mcp-dynamics/dist/index.js"]
} } }
```

## 5. Depuis une autre machine

Le service écoute sur `127.0.0.1` par défaut. Pour ouvrir le port, préférez un
tunnel SSH plutôt qu'un bind sur `0.0.0.0` — le token Bearer ne doit jamais
circuler en clair.

```bash
ssh -N -L 3000:127.0.0.1:3000 user@poste-serveur
```

Puis `http://127.0.0.1:3000/mcp` côté client.

Pour une exposition directe, `MCP_DYNAMICS_HTTP_HOST=0.0.0.0` **et** un reverse
proxy qui termine le TLS. Ne jamais faire `0.0.0.0` sans TLS : le token est en
clair et l'identité Azure est celle du serveur.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `MCP_DYNAMICS_HTTP_TOKEN` | — | **Obligatoire.** Bearer token. Sans lui le serveur refuse de démarrer. |
| `MCP_DYNAMICS_HTTP_HOST` | `127.0.0.1` | Interface d'écoute. |
| `MCP_DYNAMICS_HTTP_PORT` | `3000` | Port. |
| `MCP_DYNAMICS_HTTP_RATE` | `120` | Requêtes/min/IP. |
| `MCP_DYNAMICS_READONLY` | auto | En HTTP : `1` par défaut. `0` est le **seul** moyen d'ouvrir les écritures. |
| `DYNAMICS_INSTANCE_URL` | instance ServiceNow | Environnement Dataverse cible. |
| `MCP_DYNAMICS_ALLOWED_ENTITIES` | toutes | Liste blanche d'entités. |

`MCP_DYNAMICS_READONLY` est volontairement strict : `foo`, `""` ou `true` activent
le read-only. Seul `0` le désactive. Une coquille qui veut écrire doit le dire
explicitement.

## Sécurité — à lire avant d'exposer le port

Ce serveur est **mono-identité**. `AzureCliCredential` utilise le token du compte
qui a lancé `az login` sur la machine, et `resolveUserGuid()` sans argument fait
un `WhoAmI`. Il n'y a pas d'identité par appelant : **toute personne qui atteint
le port agit en votre nom**, lit votre pipeline et peut y écrire.

Ce qui est déjà en place :

- Bearer token obligatoire, comparé à temps constant ;
- read-only par défaut sur le transport HTTP ;
- `WRITE_ALLOWLIST` / `DELETE_DENYLIST`, `delete_record` exige `confirm` ;
- dry-run par défaut sur toute écriture ;
- rate limit ;
- les erreurs Dataverse ne renvoient plus le `$filter` brut (emails, noms de
  comptes), et les tokens sont redactés dans les logs.

Ce qui **n'est pas** couvert, et qu'il faut savoir :

1. **Pas de multi-utilisateurs.** Chaque client voit le même pipeline. Si vous
   voulez que chacun voie le sien, il faut un credential par appelant et
   supprimer le `WhoAmI` implicite — non implémenté.
2. **Le token Bearer vaut accès au CRM.** Ne le mettez ni dans un dépôt git ni
   dans un fichier lisible par d'autres comptes. Il est stocké dans
   `/etc/mcp-dynamics/env`, mode 600.
3. **`journalctl` peut contenir des noms de comptes.** Les logs sont scrubés
   (emails et tokens remplacés) mais conservent les messages d'erreur métier.
4. **Le dry-run est une commodité, pas une garantie.** Un LLM peut passer
   `dry_run: false`. Le read-only est la seule vraie barrière.

Si le service doit écrire, la bonne découpe reste celle du déploiement actuel :
service HTTP en read-only pour la consultation partagée, et `stdio` en local
depuis le poste autorisé pour les modifications.

## Reverse proxy (nginx) pour TLS

```nginx
server {
  listen 443 ssl http2;
  server_name mcp.interne.example;

  ssl_certificate     /etc/letsencrypt/live/mcp.interne.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mcp.interne.example/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    # requis pour le streaming SSE de Streamable HTTP
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
}
```

`proxy_buffering off` est obligatoire : sans lui, le serveur ne peut pas
streamer les notifications et les appels longs sont tronqués.

## Diagnostic

```bash
systemctl status mcp-dynamics
journalctl -u mcp-dynamics -f
curl -s localhost:3000/healthz | jq '.readonly, .tools, .sessions'
ss -ltnp | grep 3000          # port déjà pris ?
```

Toute la journalisation est en NDJSON sur stderr :

```json
{"event":"server_started","transport":"streamable-http","tools":26,"readonly":true}
{"event":"auth_denied","ip":"10.0.0.5"}
{"event":"session_opened","session_id":"…"}
{"event":"tool_call","tool":"get_forecast_summary","duration_ms":412,"ok":true}
```