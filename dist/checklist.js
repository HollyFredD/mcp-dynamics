/**
 * Checklist de clôture d'une opportunité ServiceNow.
 *
 * ⚠️ Tous les noms de champs ci-dessous sont issus de docs/opportunity_fields.md
 * §8 (« Process / checklist de vente (booleans) »). Aucun nom n'a été inventé.
 * Si un champ n'existe pas sur l'instance, il sera simplement absent de la
 * lecture et exclu du ratio (voir `missing` dans la sortie de
 * get_closing_readiness).
 */
/** Champs bloquants : sans eux la clôture ne peut pas être bookée. */
export const CLOSURE_BLOCKERS = [
    "sn_receivedpo",
    "sn_customersignedorderformsowandpoprovidedt",
    "sn_submitsigneddocumentsforclosure",
];
/** Libellés lisibles des bloqueurs (docs §8). */
export const BLOCKER_LABELS = {
    sn_receivedpo: "Purchase Order received from the customer",
    sn_customersignedorderformsowandpoprovidedt: "Customer has signed the Order Form / SOW / PO",
    sn_submitsigneddocumentsforclosure: "Signed documents submitted for closure",
};
/**
 * Regroupement des ~150 booléens de checklist en 5 groupes fonctionnels.
 * Les groupes correspondent au workflow réel : paperwork d'abord, puis
 * commercial, sponsors, solution, valeur.
 */
export const CHECKLIST_GROUPS = [
    {
        key: "order_form",
        label: "Order form / contract paperwork",
        fields: [
            "sn_customerreviewingnegotiatingorderform",
            "sn_orderfromsubmittedapproved",
            "sn_orderdocumentscompletedandsenttochampion",
            "sn_approveddocumentssenttochampion",
            "sn_powithprocurement",
            "sn_receivedof",
            "sn_receivedpo",
            "sn_orderformcontractreviewcompleted",
            "sn_contractreview",
            "sn_contracts",
            "sn_customersignedorderformsowandpoprovidedt",
            "sn_decisionmakeragreedtosowterms",
            "sn_finalproposalsignedoffbydecisionmaker",
            "sn_snprovidescountersignatureonsow",
            "sn_sendcountersigneddocumentstocustomer",
            "sn_submitsigneddocumentsforclosure",
            "sn_submittedforbooking",
            "sn_paperworkinprocess",
            "sn_ofrequested",
            "sn_ofsenttocustomer",
            "sn_ofroutingforapprovals",
            "sn_servicessalesapprovals",
        ],
    },
    {
        key: "commercial",
        label: "Commercial agreement & mutual close plan",
        fields: [
            "sn_pricingagreed",
            "sn_budgetcommitment",
            "sn_purchasetimeframeagreed",
            "sn_closeplandefinedandmutuallyagreed",
            "sn_closeplanagreed",
            "sn_closeplanagreednomoa",
            "sn_createmutualcloseplan",
            "sn_reconfirmcloseplan",
            "sn_moacompleted",
            "sn_jointactionplanagreed",
            "sn_dealvalidation",
            "sn_riskmgmtreview",
            "sn_legalcheck",
            "sn_compliancecheck",
            "sn_requestdealscopingsupport",
            "sn_purchasehistoryreview",
        ],
    },
    {
        key: "stakeholder",
        label: "Stakeholders, security & procurement",
        fields: [
            "sn_stakeholderidd",
            "sn_securitystakeholdersignedoff",
            "sn_customersecurityhassignedoff",
            "sn_snapsubmittedtosecuritystakeholder",
            "sn_powerbuyersengaged",
            "sn_powerbuyersinquiry",
            "sn_powerbuyercommitment",
            "sn_customerlegalandprocurementengaged",
            "sn_championfundingidentified",
            "sn_trainingchampionfundingidentified",
            "sn_sendmutualplandrafttochampion",
            "sn_createinitiatejointactionplanletter",
        ],
    },
    {
        key: "solution",
        label: "Solution design & solution consulting",
        fields: [
            "sn_differentiatedvalueidentified",
            "sn_businessoutcomesidentified",
            "sn_businessoutcomesexploration",
            "sn_customervaluedefined",
            "sn_customeroutcomessalesstrategydefined",
            "sn_engagecustomeroutcomes",
            "sn_solutiondifferentiated",
            "sn_snappresentedtocustomer",
            "sn_overviewpresented",
            "sn_solutionpresentedtocustomer",
            "sn_engagementmodeldefined",
            "sn_determinecodeliverymodel",
            "sn_customeralignedonengagementmodelandscope",
            "sn_proposalsupportsbvarealization",
            "sn_scopedevelopmentcreateproposal",
            "sn_implementationproposaltrainingplanpresent",
            "sn_alignmentwithinspirebva",
            "sn_sc_technicalwin",
            "sn_sc_workshops",
            "sn_sc_pov",
            "sn_sc_demo",
            "sn_tcspresented",
        ],
    },
    {
        key: "value",
        label: "Business value & sponsor validation",
        fields: [
            "sn_objectivesagreedwithsponsor",
            "sn_differentiatedvaluevalidatedwithsponsor",
            "sn_businesscasevalidatedwithsponsor",
            "sn_technicalwinwithsponsor",
            "sn_valueperspective",
            "sn_hasbusinesscase",
            "sn_businessvalueassessment",
            "sn_bva",
            "sn_valuemgmtengaged",
            "sn_swotanalysiscreated",
            "sn_customerdashboardreview",
            "sn_opportunitysummarycreated",
            "sn_opportunitysummarycompletedeconomicbuyeri",
            "sn_estimatesvalidated",
            "sn_subscriptionguide",
            "sn_validateskusforrenewal",
            "sn_requestsubscriptionreminders",
            "sn_trainingplanagreed",
            "sn_implementationsuccessscorecard",
            "sn_staffingawarenesswithresourcemanagement",
            "sn_staffingdemandswithresourcemanagement",
            "sn_scheduleipktcustomerhandoff",
            "sn_sowdraftalignedwithcustomerfordelivery",
        ],
    },
];
/** Tous les champs de checklist, dédupliqués. */
export function allChecklistFields() {
    return [...new Set(CHECKLIST_GROUPS.flatMap((g) => g.fields))];
}
/** Groupes dans lesquels un bloqueur se trouve (pour le verdict). */
export function blockerGroups() {
    const blockers = new Set(CLOSURE_BLOCKERS);
    return CHECKLIST_GROUPS.filter((g) => g.fields.some((f) => blockers.has(f))).map((g) => g.key);
}
//# sourceMappingURL=checklist.js.map