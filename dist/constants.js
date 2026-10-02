/**
 * Centralisation des constantes métier / codes d'options Dataverse.
 *
 * Toutes les valeurs ci-dessous proviennent de l'instance servicenow.crm.dynamics.com
 * ou de docs/opportunity_fields.md. Elles sont regroupées ici pour éviter la
 * duplication (qui avait produit 3 définitions divergentes de FORECAST_CODES).
 */
// ---------------------------------------------------------------------------
// Rôles sur l'opportunité
// ---------------------------------------------------------------------------
/**
 * Rôle métier → nom du champ de lookup sur `opportunity`.
 * Source : docs/opportunity_fields.md §1 et §3.
 * Utilisé par get_my_opportunities, get_at_risk_deals, search_opportunities…
 * `renormalized` = version FetchXML du même lookup (le nom de l'attribut).
 */
export const ROLE_FIELDS = {
    owner: "_ownerid_value",
    field_sales_rep: "_sn_fieldsalesrep_value",
    solution_consultant: "_sn_solutionconsultant_value",
    secondary_sales_rep: "_sn_secondarysalesrep_value",
    renewal_account_manager: "_sn_renewalaccountmanager_value",
};
/** Rôle → nom d'attribut utilisable dans un FetchXML (`ownerid`, `sn_fieldsalesrep`…). */
export const ROLE_FIELDS_FETCHXML = {
    owner: "ownerid",
    field_sales_rep: "sn_fieldsalesrep",
    solution_consultant: "sn_solutionconsultant",
    secondary_sales_rep: "sn_secondarysalesrep",
    renewal_account_manager: "sn_renewalaccountmanager",
};
export const ROLE_NAMES = Object.keys(ROLE_FIELDS);
/** Valeur « any » acceptée par les inputSchema de rôle. */
export const ROLE_ANY = "any";
export const ROLE_CHOICES = [...ROLE_NAMES, ROLE_ANY];
// ---------------------------------------------------------------------------
// Statuts d'opportunité
// ---------------------------------------------------------------------------
/** statecode (entier) sur `opportunity`. 0=Open, 1=Won, 2=Lost. */
export const STATUS_CODES = { open: 0, won: 1, lost: 2 };
export const STATUS_CHOICES = [...Object.keys(STATUS_CODES), "all"];
/** Constante à injecter dans tout filtre d'entité : ne lire que les lignes actives. */
export const STATE_OPEN = STATUS_CODES.open;
// ---------------------------------------------------------------------------
// Catégories de prévision
// ---------------------------------------------------------------------------
/**
 * sn_forecastcategory (opportunity) ET sn_specialistforecastcategory
 * (sn_specialistforecast) partagent les mêmes codes.
 *
 * ⚠️ Seuls 876130003 (Closed) et 876130006 (Upside) sont explicitement confirmés
 * par docs/opportunity_fields.md §5. Les autres ont été relevés sur l'instance
 * servicenow mais DOIVENT être revérifiés avec l'outil `list_picklist_values`
 * avant d'être utilisés pour un engagement contractuel.
 */
export const FORECAST_CODES = {
    pipeline: 876130000,
    best_case: 876130001,
    committed: 876130002,
    closed: 876130003,
    upside: 876130006,
};
/** Catégories proposables en écriture (closed est en lecture seule côté métier). */
export const FORECAST_WRITABLE = ["pipeline", "best_case", "committed", "upside"];
export const FORECAST_CHOICES = [
    ...Object.keys(FORECAST_CODES),
    "all",
];
/** code -> libellé lisible (aussi utilisé pour `unknown_categories`). */
export const CATEGORY_LABELS = Object.fromEntries(Object.entries(FORECAST_CODES).map(([k, v]) => [v, k]));
/** Seuils d'analyse « at risk » (probabilité, en pourcentage, sur `closeprobability`). */
export const AT_RISK = {
    /** Un deal committed/best_case sous cette probabilité est « mal aligné ». */
    misalignedProbability: 30,
    /** Catégories considérées comme « engagées » pour le test de probabilité. */
    committedCategories: [FORECAST_CODES.committed, FORECAST_CODES.best_case],
    /** Bornes par défaut de stale_days. */
    staleDaysMin: 1,
    staleDaysMax: 365,
    staleDaysDefault: 30,
};
// ---------------------------------------------------------------------------
// Types de notes de collaboration
// ---------------------------------------------------------------------------
/**
 * sn_activitynotetype sur `sn_activitycustomnoteses`.
 * Source : instance servicenow (picklist `sn_activitynotetype`).
 * ⚠️ Vérifiable via list_picklist_values(entity="sn_activitycustomnoteses",
 *    attribute="sn_activitynotetype").
 */
export const COLLAB_NOTE_TYPES = {
    "Win/Loss": 876130000,
    General: 876130001,
    "Next Steps": 876130002,
};
export const COLLAB_NOTE_TYPE_CHOICES = Object.keys(COLLAB_NOTE_TYPES);
export const DEFAULT_COLLAB_NOTE_TYPE = "Next Steps";
/** Longueur max du champ `subject` sur une note (Dataverse rejette au-delà). */
export const SUBJECT_MAX_LENGTH = 100;
// ---------------------------------------------------------------------------
// Devises / unité de mesure
// ---------------------------------------------------------------------------
/**
 * ⚠️ Ces GUID sont PROPRES à l'instance servicenow.crm.dynamics.com : ils ont été
 * relevés manuellement. Ils sont désormais résolus dynamiquement (voir
 * dataverse.ts → resolveCurrencyGuid / resolvePrimaryUnitId, avec cache) ; ces
 * valeurs ne servent plus que de repli si la résolution dynamique échoue.
 */
export const CURRENCY_GUIDS = {
    EUR: "0898499a-8c89-e911-a83e-000d3a1781be",
    USD: "49af6d94-5c58-e911-a963-000d3a4e898a",
};
export const DEFAULT_CURRENCY = "EUR";
export const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_GUIDS);
/** ⚠️ GUID spécifique à l'instance — repli uniquement (résolution dynamique par `isprimary eq true`). */
export const PRIMARY_UNIT_ID = "93c725cf-309d-4ce2-b301-c62da5add0ed";
// ---------------------------------------------------------------------------
// Sécurité / garde-fous d'écriture
// ---------------------------------------------------------------------------
/**
 * Entités autorisées en écriture via create_record / update_record / add_*.
 * `sn_specialistforecasts` en est volontairement absente : elle passe par
 * update_specialist_forecast (avec dry_run + confirm).
 */
export const WRITE_ALLOWLIST = [
    "opportunities",
    "opportunityproducts",
    "sn_opportunitysubproductses",
    "sn_activitycustomnoteses",
    "tasks",
    "notes",
    "contacts",
    "accounts",
];
/** Entités système strictement interdites en suppression. */
export const DELETE_DENYLIST = [
    "systemusers",
    "systemroles",
    "roleassignments",
    "systemsettings",
    "businessunits",
    "teams",
    "usersettings",
    "sn_specialistforecasts",
];
/** Sous-chaînes interdites dans un nom d'entité (traversée de chemin / métadonnées). */
export const FORBIDDEN_ENTITY_SUBSTRINGS = ["..", "/", "\\", "?"];
// ---------------------------------------------------------------------------
// Trimestres
// ---------------------------------------------------------------------------
/**
 * Format canonique des trimestres : `YY-Qn` (ex: `26-Q3`). C'est le format
 * stocké dans `sn_closequarter`. `normalizeQuarter()` accepte les variantes.
 */
export const QUARTER_CANONICAL_RE = /^(\d{2})-Q([1-4])$/;
/** Formats tolérés en entrée : 26-Q3, 2026-Q3, 26Q3, Q3-26, Q3/2026, 3-2026. */
export const QUARTER_RE = /^(?:(\d{4}|\d{2})[\s\-_/]?Q([1-4])|Q([1-4])[\s\-_/]?(\d{4}|\d{2}))$/i;
// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------
/** `sn_probability` est CALCULÉ et de type STRING ("100%"). */
export const SN_PROBABILITY_FIELD = "sn_probability";
/** Le champ numérique de probabilité (entier 0-100). */
export const CLOSE_PROBABILITY_FIELD = "closeprobability";
/** Plafonds de pagination. */
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_QUERY_ROWS = 50;
/** Plafond dur de `queryAll()` : au-delà on tronque et on le signale. */
export const HARD_PAGE_CAP = 5000;
export const DEFAULT_MAX_PAGES = 10;
/** TTL (ms) du cache mémoire court sur les métadonnées. */
export const CACHE_TTL_MS = 60_000;
/** Marge de sécurité avant expiration du token Azure. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** Timeout axios : lecture standard / écritures (plugins Dataverse lents). */
export const READ_TIMEOUT_MS = 30_000;
export const WRITE_TIMEOUT_MS = 120_000;
/** Retry sur 429/5xx. */
export const MAX_RETRIES = 4;
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 20_000;
//# sourceMappingURL=constants.js.map