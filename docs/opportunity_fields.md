# Champs modifiables - Entité Opportunity (Dynamics 365)

Entité : `opportunity` | Clé primaire : `opportunityid` | Champ nom : `name`

---

## 1. Identification & relations

| Champ API | Label | Type | Notes |
|---|---|---|---|
| `name` | Nom de l'opportunité | string | Requis |
| `description` | Description | string (multiline) | |
| `emailaddress` | Email | string | |
| `_customerid_value` | Compte client | lookup → `account` | Navigateur : `customerid_account` |
| `_parentaccountid_value` | Compte parent | lookup → `account` | Navigateur : `parentaccountid` |
| `_parentcontactid_value` | Contact parent | lookup → `contact` | Navigateur : `parentcontactid` |
| `_contactid_value` | Contact | lookup → `contact` | Navigateur : `customerid_contact` |
| `_ownerid_value` | Propriétaire | lookup → `systemuser` | Navigateur : `ownerid` |
| `_campaignid_value` | Campagne source | lookup → `campaign` | |
| `_originatingleadid_value` | Lead d'origine | lookup → `lead` | |
| `_pricelevelid_value` | Grille tarifaire | lookup → `pricelevel` | Navigateur : `pricelevelid` |
| `_transactioncurrencyid_value` | Devise | lookup → `transactioncurrency` | Navigateur : `transactioncurrencyid` |

---

## 2. Informations commerciales (OOB)

| Champ API | Label | Type | Valeurs possibles |
|---|---|---|---|
| `estimatedvalue` | Chiffre d'affaires estimé | decimal | |
| `estimatedclosedate` | Date de clôture estimée | date | |
| `actualclosedate` | Date de clôture réelle | date | |
| `actualvalue` | Chiffre d'affaires réel | decimal | |
| `closeprobability` | Probabilité de clôture | integer | 0-100 |
| `salesstage` | Étape de vente | picklist | 0=Qualify, 1=Develop, 2=Propose, 3=Close |
| `salesstagecode` | Code étape de vente | picklist | 1=Default Value |
| `opportunityratingcode` | Qualification | picklist | 1=Hot, 2=Warm, 3=Cold |
| `prioritycode` | Priorité | picklist | 1=Default Value |
| `statecode` | Statut | picklist | 0=Open, 1=Won, 2=Lost (attention : setter via `Win`/`Lose` actions) |
| `statuscode` | Raison du statut | picklist | 1=In Progress, 2=On Hold, 3=Won, 4=Cancelled, 5=Out-Sold |
| `msdyn_forecastcategory` | Catégorie de prévision | picklist | 100000001=Pipeline, 100000002=Best Case, 100000003=Committed, 100000004=Omitted, 100000005=Won, 100000006=Lost |
| `budgetamount` | Budget | decimal | |
| `budgetstatus` | Statut du budget | picklist | 0=No Committed Budget, 1=May Buy, 2=Can Buy, 3=Will Buy |
| `purchasetimeframe` | Délai d'achat | picklist | 0=Immediate, 1=This Quarter, 2=This Year, 3=Unknown, 4=Next Year |
| `purchaseprocess` | Processus d'achat | picklist | 0=Unknown, 1=Individual, 2=Committee |
| `initialcommunication` | Premier contact | picklist | 0=Contacted, 1=Not Contacted |
| `timeline` | Délai estimé | picklist | 0=Immediate, 1=This Quarter, 2=This Year, 3=Unknown, 4=Next Year |
| `need` | Besoin | picklist | 0=Must Have, 1=Should Have, 2=Good to Have, 3=No Need |
| `finaldecisiondate` | Date de décision finale | date | |
| `discountpercentage` | Remise % | decimal | |
| `discountamount` | Remise montant | decimal | |
| `freightamount` | Frais de port | decimal | |
| `isrevenuesystemcalculated` | CA calculé par le système | boolean | false=User Provided, true=System Calculated |
| `skippricecalculation` | Ignorer calcul de prix | picklist | 0=DoPriceCalcAlways |
| `qualificationcomments` | Commentaires qualification | string (multiline) | |
| `quotecomments` | Commentaires devis | string (multiline) | |
| `currentsituation` | Situation actuelle | string (multiline) | |
| `customerneed` | Besoin client | string (multiline) | |
| `customerpainpoints` | Points de douleur | string (multiline) | |
| `proposedsolution` | Solution proposée | string (multiline) | |
| `participatesinworkflow` | Participe au workflow | boolean | |
| `overriddencreatedon` | Date de création surchargée | datetime | |
| `importsequencenumber` | N° séquence import | integer | |

---

## 3. Lookup SN (champs personnalisés relationnels)

| Champ API | Label | Entité liée |
|---|---|---|
| `_sn_fieldsalesrep_value` | Représentant terrain | `systemuser` |
| `_sn_secondarysalesrep_value` | Représentant terrain secondaire | `systemuser` |
| `_sn_executivesponsor_value` | Sponsor exécutif | `systemuser` |
| `_sn_solutionconsultant_value` | Solution Consultant | `systemuser` |
| `_sn_renewalaccountmanager_value` | Renewal Account Manager | `systemuser` |
| `_sn_customercontact_value` | Contact client SN | `contact` |
| `_sn_servicenowcontact_value` | Contact ServiceNow | `contact` |
| `_sn_fieldterritory_value` | Territoire terrain | `territory` |
| `_sn_doublecompterritory_value` | Territoire double comp | `territory` |
| `_sn_transactingpartnerid_value` | Partenaire transactionnel | `account` |
| `_sn_originalsalespartner_value` | Partenaire de vente original | `account` |
| `_sn_partneraccountforimplementationmode_value` | Partenaire d'implémentation | `account` |
| `_sn_endcustomerid_value` | Client final | `account` |
| `_sn_incumbentvendor_value` | Fournisseur en place | `account` |
| `_sn_competitorlostagainst_value` | Concurrent face auquel perdu | `competitor` |
| `_sn_buyinggroup_value` | Groupe d'achat | lookup |
| `_sn_cpqmasterquote_value` | Devis CPQ principal | lookup |
| `_sn_copiedfrom_value` | Copié depuis | `opportunity` |
| `_sn_lead_number_value` | N° de lead | lookup |
| `_sn_p4members_value` | Membres P4 | lookup |

---

## 4. Valeurs financières SN

| Champ API | Label | Type | Notes |
|---|---|---|---|
| `sn_netnewacv` | Net New ACV | decimal | En devise locale |
| `sn_renewalacv` | Renewal ACV | decimal | |
| `sn_totalnnacv` | Total NNACV | decimal | |
| `sn_totalvalue` | Valeur totale | decimal | |
| `sn_psrevenue` | PS Revenue | decimal | |
| `sn_trainingrevenue` | Training Revenue | decimal | |
| `sn_otherrevenue` | Other Revenue | decimal | |
| `sn_netnewacvfuture` | Net New ACV (futur) | decimal | |
| `sn_renewalacvnetfinancials` | Renewal ACV Net Financials | decimal | |
| `sn_nnacvnetfinancials` | NNACV Net Financials | decimal | |
| `sn_nnacvfuturenetfinancials` | NNACV Future Net Financials | decimal | |
| `sn_annualrate` | Taux annuel | decimal | |
| `sn_annualrateyear` | Année du taux annuel | date | |
| `sn_fxrate` | Taux de change | decimal | |
| `sn_fxrateusd` | Taux de change USD | decimal | |
| `sn_exchangerateoverride` | Override taux de change | decimal | |
| `sn_currencycode` | Code devise | string | Ex: "USD" |

---

## 5. Classification & pipeline SN

| Champ API | Label | Type | Valeurs clés |
|---|---|---|---|
| `sn_salesstage` | Étape de vente SN | picklist | 876130000=1-Qualification, 876130002=2-Discovery, 876130009=8-Closed Won |
| `sn_opportunitytype` | Type d'opportunité | picklist | 876130000=New Business, 876130001=Renewal, etc. |
| `sn_opportunityflavor` | Nature de l'opportunité | picklist | 876130000=Mixed, etc. |
| `sn_forecastcategory` | Catégorie prévision SN | picklist | 876130003=Closed, 876130006=Upside, etc. |
| `sn_channeltransactiontype` | Type de transaction canal | picklist | 876130006=Non-Partnered, etc. |
| `sn_pipelinesourcecode` | Source du pipeline | picklist | 876130002=ACE, etc. |
| `sn_opportunitysource` | Source de l'opportunité | picklist | 876130003=App Store, etc. |
| `sn_closequarter` | Trimestre de clôture | string | Ex: "24-Q3" |
| `sn_probability` | Probabilité (affichage) | string | Ex: "100%" |
| `sn_opportunitybulist` | Liste des BU | string | Code(s) BU |
| `sn_opportunitybusinessunitlist` | Noms des BU | string | Ex: "App Engine" |
| `sn_productcategorylist` | Catégories produits | string | Ex: "Subscriptions" |
| `sn_industrysolution` | Solution industrie | string | |
| `sn_programtagginglist` | Tags programme | string | |
| `sn_routetomarketlabel` | Label route to market | string | |
| `sn_renewalcategorycode` | Code catégorie renouvellement | picklist | |
| `sn_renewaltiming` | Timing de renouvellement | picklist | |
| `sn_renewalengagement` | Engagement renouvellement | picklist | |
| `sn_renewalrisk` | Risque de renouvellement | picklist | |
| `sn_renewalriskreason` | Raison du risque | string | |
| `sn_renewalriskcodes` | Codes risque | string (multiselect) | |
| `sn_renewalriskreasoncodes` | Codes raison risque | string (multiselect) | |
| `sn_renewalriskreasoncodessingleselect` | Code raison risque (single) | picklist | |
| `sn_renewaltimingcodes` | Codes timing renouvellement | string | |
| `sn_currentcontractenddate` | Date fin contrat actuel | date | |
| `sn_autorenewaloptin` | Opt-in renouvellement auto | picklist | |
| `sn_autorenewaloptoutreason` | Raison d'opt-out auto | string | |
| `sn_eligibleforautorenewallanguage` | Éligible langage auto-renouvellement | string | |

---

## 6. Partenaires & canal

| Champ API | Label | Type | Notes |
|---|---|---|---|
| `sn_partnered` | Avec partenaire | boolean | |
| `sn_partneridentified` | Partenaire identifié | boolean | |
| `sn_primarypartnersengaged` | Partenaires principaux engagés | boolean | |
| `sn_partnerecosystemunderstood` | Écosystème partenaire compris | boolean | |
| `sn_partneradvisorysolutionofferingleveragedi` | Advisory partner leveraged | boolean | |
| `sn_reviewpartnerstrategy` | Stratégie partenaire revue | boolean | |
| `sn_reviewpartnersproposal` | Proposition partenaire revue | boolean | |
| `sn_partnerhasasignedcontractchangeorder` | Partenaire a signé contrat | boolean | |
| `sn_partnerprlconfirmation` | Confirmation PRL partenaire | boolean | |
| `sn_doublecompeligible` | Éligible double comp | boolean | |
| `sn_splitoppty` | Opportunité splitée | boolean | |
| `sn_splitopptyeveryone` | Split tous | boolean | |
| `sn_splitthisopportunity` | Splitter cette opportunité | boolean | |
| `sn_salesallocationpercentage` | % allocation ventes | string | |
| `sn_aceallocationpercentage` | % allocation ACE | string | |
| `sn_marketingallocationpercentage` | % allocation marketing | string | |

---

## 7. Équipe & sponsorship

| Champ API | Label | Type | Notes |
|---|---|---|---|
| `sn_strategic` | Stratégique | boolean | |
| `sn_activestrategic` | Stratégique actif | boolean | |
| `sn_sponsoredidentified` | Sponsor identifié | boolean | |
| `sn_objectivesagreedwithsponsor` | Objectifs alignés avec sponsor | boolean | |
| `sn_differentiatedvaluevalidatedwithsponsor` | Valeur différenciée validée avec sponsor | boolean | |
| `sn_businesscasevalidatedwithsponsor` | Business case validé avec sponsor | boolean | |
| `sn_technicalwinwithsponsor` | Victoire technique avec sponsor | boolean | |
| `sn_valueperspective` | Value perspective | boolean | |
| `sn_hasbusinesscase` | A un business case | boolean | |
| `sn_businessvalueassessment` | Assessment valeur métier | boolean | |

---

## 8. Process / checklist de vente (booleans)

Ces champs tracent l'avancement des étapes de vente. Tous sont de type `boolean`.

| Champ API | Label |
|---|---|
| `confirminterest` | Confirmer l'intérêt |
| `evaluatefit` | Évaluer l'adéquation |
| `pursuitdecision` | Décision de poursuite |
| `identifycustomercontacts` | Identifier contacts client |
| `identifypursuitteam` | Identifier équipe de poursuite |
| `identifycompetitors` | Identifier concurrents |
| `decisionmaker` | Décideur identifié |
| `presentproposal` | Présenter la proposition |
| `developproposal` | Développer la proposition |
| `completefinalproposal` | Finaliser la proposition |
| `presentfinalproposal` | Présenter la proposition finale |
| `completeinternalreview` | Compléter la revue interne |
| `filedebrief` | Archiver le débrief |
| `captureproposalfeedback` | Capturer feedback proposition |
| `resolvefeedback` | Résoudre le feedback |
| `sendthankyounote` | Envoyer note de remerciement |
| `sn_completestage0` | Compléter l'étape 0 |
| `sn_differentiatedvalueidentified` | Valeur différenciée identifiée |
| `sn_businessoutcomesidentified` | Résultats métier identifiés |
| `sn_businessoutcomesexploration` | Exploration résultats métier |
| `sn_customervaluedefined` | Valeur client définie |
| `sn_customeroutcomessalesstrategydefined` | Stratégie vente / résultats client définie |
| `sn_engagecustomeroutcomes` | Engager résultats client |
| `sn_solutiondifferentiated` | Solution différenciée |
| `sn_snappresentedtocustomer` | App SN présentée au client |
| `sn_overviewpresented` | Vue d'ensemble présentée |
| `sn_solutionpresentedtocustomer` | Solution présentée au client |
| `sn_engagementmodeldefined` | Modèle d'engagement défini |
| `sn_determinecodeliverymodel` | Déterminer modèle co-delivery |
| `sn_customeralignedonengagementmodelandscope` | Client aligné sur modèle et scope |
| `sn_proposalsupportsbvarealization` | Proposition supporte réalisation BVA |
| `sn_scopedevelopmentcreateproposal` | Développer scope / créer proposition |
| `sn_implementationproposaltrainingplanpresent` | Plan formation présenté |
| `sn_alignmentwithinspirebva` | Alignement avec Inspire BVA |
| `sn_powerbuyersengaged` | Power buyers engagés |
| `sn_powerbuyersinquiry` | Enquête power buyers |
| `sn_powerbuyercommitment` | Engagement power buyers |
| `sn_stakeholderidd` | Stakeholder identifié |
| `sn_securitystakeholdersignedoff` | Stakeholder sécurité signé |
| `sn_customersecurityhassignedoff` | Sécurité client signée |
| `sn_snapsubmittedtosecuritystakeholder` | SNAP soumis au stakeholder sécurité |
| `sn_purchasetimeframeagreed` | Délai d'achat convenu |
| `sn_closeplandefinedandmutuallyagreed` | Plan de clôture défini et mutuellement convenu |
| `sn_closeplanagreed` | Plan de clôture convenu |
| `sn_closeplanagreednomoa` | Plan de clôture convenu (sans MOA) |
| `sn_createmutualcloseplan` | Créer plan de clôture mutuel |
| `sn_reconfirmcloseplan` | Reconfirmer le plan de clôture |
| `sn_moacompleted` | MOA complété |
| `sn_jointactionplanagreed` | Plan d'action conjoint convenu |
| `sn_pricingagreed` | Tarification convenue |
| `sn_budgetcommitment` | Engagement budget |
| `sn_requestdealscopingsupport` | Demander support scoping |
| `sn_dealvalidation` | Validation du deal |
| `sn_riskmgmtreview` | Revue gestion des risques |
| `sn_legalcheck` | Vérification légale |
| `sn_compliancecheck` | Vérification conformité |
| `sn_servicessalesapprovals` | Approbations services ventes |
| `sn_ofroutingforapprovals` | Routage OF pour approbations |
| `sn_ofrequested` | OF demandé |
| `sn_ofsenttocustomer` | OF envoyé au client |
| `sn_customerreviewingnegotiatingorderform` | Client révisant/négociant l'OF |
| `sn_orderfromsubmittedapproved` | OF soumis et approuvé |
| `sn_orderdocumentscompletedandsenttochampion` | Documents OF complétés et envoyés au champion |
| `sn_approveddocumentssenttochampion` | Documents approuvés envoyés au champion |
| `sn_powithprocurement` | PO avec procurement |
| `sn_receivedof` | OF reçu |
| `sn_receivedpo` | PO reçu |
| `sn_orderformcontractreviewcompleted` | Revue contrat OF complétée |
| `sn_contractreview` | Revue contrat |
| `sn_contracts` | Contrats |
| `sn_customerlegalandprocurementengaged` | Legal et procurement client engagés |
| `sn_customersignedorderformsowandpoprovidedt` | Client a signé OF/SOW/PO |
| `sn_decisionmakeragreedtosowterms` | Décideur d'accord sur termes SOW |
| `sn_finalproposalsignedoffbydecisionmaker` | Proposition finale signée par décideur |
| `sn_snprovidescountersignatureonsow` | SN fournit contre-signature SOW |
| `sn_sendcountersigneddocumentstocustomer` | Envoyer documents contre-signés au client |
| `sn_submitsigneddocumentsforclosure` | Soumettre documents signés pour clôture |
| `sn_submittedforbooking` | Soumis pour booking |
| `sn_paperworkinprocess` | Paperwork en cours |
| `sn_purchasehistoryreview` | Revue historique d'achat |
| `sn_subscriptionguide` | Guide de souscription |
| `sn_validateskusforrenewal` | Valider SKUs pour renouvellement |
| `sn_requestsubscriptionreminders` | Demander rappels souscription |
| `sn_sendmutualplandrafttochampion` | Envoyer brouillon plan mutuel au champion |
| `sn_createinitiatejointactionplanletter` | Créer lettre plan d'action conjoint |
| `sn_trainingplanagreed` | Plan formation convenu |
| `sn_trainingchampionfundingidentified` | Financement champion formation identifié |
| `sn_championfundingidentified` | Financement champion identifié |
| `sn_implementationsuccessscorecard` | Scorecard succès implémentation |
| `sn_estimatesvalidated` | Estimations validées |
| `sn_staffingawarenesswithresourcemanagement` | Connaissance staffing avec resource mgmt |
| `sn_staffingdemandswithresourcemanagement` | Demandes staffing avec resource mgmt |
| `sn_scheduleipktcustomerhandoff` | Planifier handoff client IPKT |
| `sn_sowdraftalignedwithcustomerfordelivery` | Draft SOW aligné client pour delivery |
| `sn_implementationsuccessscorecard` | Scorecard succès implémentation |
| `sn_bva` | BVA |
| `sn_valuemgmtengaged` | Value management engagé |
| `sn_swotanalysiscreated` | Analyse SWOT créée |
| `sn_customerdashboardreview` | Revue dashboard client |
| `sn_opportunitysummarycreated` | Résumé opportunité créé |
| `sn_opportunitysummarycompletedeconomicbuyeri` | Résumé oppty complété par acheteur économique |
| `sn_taeengagedtraining` | TAE engagé training |
| `sn_tcspresented` | TCS présenté |
| `sn_snappresentedtocustomer` | SNAP présenté au client |

---

## 9. Solution Consulting (SC)

| Champ API | Label | Type | Valeurs |
|---|---|---|---|
| `sn_sctechnicalwin` | SC Technical Win | picklist | 876130000=No |
| `sn_sc_technicalwin` | SC Technical Win (copie) | boolean | |
| `sn_scworkshops` | SC Workshops | picklist | 876130000=No |
| `sn_sc_workshops` | SC Workshops (copie) | boolean | |
| `sn_scpov` | SC POV | picklist | 876130000=No |
| `sn_sc_pov` | SC POV (copie) | boolean | |
| `sn_scdemo` | SC Demo | picklist | 876130000=No |
| `sn_sc_demo` | SC Demo (copie) | boolean | |

---

## 10. Métadonnées & divers

| Champ API | Label | Type | Notes |
|---|---|---|---|
| `sn_number` | N° opportunité SN | string | Ex: "OPTY2591232" - généralement en lecture seule |
| `sn_surf_sysid` | Surf Sys ID | string | Identifiant système source |
| `sn_outreachid` | Outreach ID | string | |
| `sn_hyperscalerdealid` | Hyperscaler Deal ID | string | |
| `sn_opptyrecordid` | Record ID oppty | string | |
| `sn_noncompetitive` | Non-compétitif | string | |
| `sn_risktype` | Type de risque | picklist | |
| `sn_riskmitigationsteps` | Étapes mitigation du risque | string (multiline) | |
| `sn_winlossnodecisionreason` | Raison win/loss/no decision | picklist | 876130019=No Reason Code Provided |
| `sn_winlossnodecisionnotes` | Notes win/loss/no decision | string (multiline) | |
| `sn_opportunitycompetitors` | Concurrents | string | |
| `sn_didmarketinghelp` | Marketing a-t-il aidé ? | picklist | 876130001=No |
| `sn_whichmarketingprogramevent` | Programme/événement marketing | string | |
| `sn_doyouwanttoassociatealeadmeeting` | Associer une réunion lead | string | |
| `sn_isautogenerated` | Auto-généré | boolean | |
| `sn_activatesequences` | Activer séquences | boolean | |
| `sn_hyperscalerforecastcategory` | Catégorie prévision hyperscaler | picklist | |
| `sn_serviceproviderusagetype` | Type usage fournisseur de services | picklist | |
| `sn_implementationmodecode` | Code mode d'implémentation | picklist | |
| `sn_terminationtype` | Type de résiliation | picklist | |
| `sn_originalsalestype` | Type de vente original | picklist | |
| `sn_noncompetitiveupdatedby` | Mis à jour par (non-compétitif) | string | |
| `sn_renewalguideline` | Directive renouvellement | string | |
| `sn_submitbooking` | Soumettre le booking | picklist | |
| `sn_golivedate` | Date de go-live | date | |
| `sn_optionperiod` | Période d'option | string | |
| `sn_buyinggroups` | Groupes d'achat | string | |
| `sn_buyinggroups` | Groupes d'achat | string | |
| `sn_influencedetailslabel` | Détails d'influence | string | |
| `wi_version` | Version WI | string | |
| `wi_wileadid` | WI Lead ID | string | |
| `wi_webinfinityid` | Web Infinity ID | string | |
| `wi_contactlastupdate` | Dernière MAJ contact WI | datetime | |
| `wi_sharetowi` | Partager vers WI | boolean | |
| `wi_workflowstatus` | Statut workflow WI | string | |

---

## Champs en lecture seule (ne pas inclure dans les outils MCP)

| Champ | Raison |
|---|---|
| `opportunityid` | Clé primaire, auto-générée |
| `versionnumber` | Concurrence optimiste, géré par le système |
| `createdon`, `modifiedon` | Horodatages système |
| `_createdby_value`, `_modifiedby_value` | Audit automatique |
| `_owningbusinessunit_value`, `_owningteam_value`, `_owninguser_value` | Dérivés du propriétaire |
| `totallineitemamount`, `totalamount`, `totaltax`, etc. | Calculés depuis les lignes de commande |
| Tous les champs `_base` (ex: `sn_netnewacv_base`) | Équivalent en devise de base, calculé |
| `exchangerate` | Calculé depuis la devise |
| `pricingerrorcode` | Géré par le moteur de tarification |
| `sn_recordurl` | URL générée automatiquement |
| `sn_probability` | Calculé |
| `msdyn_opportunityscore`, `msdyn_opportunityscoretrend` | Score IA, calculé |
| `sn_opportunitystagecomplete`, `sn_discoverystagecomplete`, etc. | Rollup d'étapes, calculés |
| `sn_countsalesleadersponsoroptycollab` | Compteur calculé |
| `sn_opportunitysummariescreated` | Compteur calculé |

---

## Recommandations pour les outils MCP

Priorité haute (à exposer en premier) :
- `name`, `estimatedvalue`, `estimatedclosedate`, `statecode`, `statuscode`
- `sn_salesstage`, `sn_forecastcategory`, `msdyn_forecastcategory`
- `sn_opportunitytype`, `sn_channeltransactiontype`, `sn_pipelinesourcecode`
- `_customerid_value`, `_ownerid_value`, `_sn_fieldsalesrep_value`
- `sn_netnewacv`, `sn_renewalacv`, `sn_totalvalue`
- `sn_winlossnodecisionreason`, `sn_winlossnodecisionnotes`
- `description`, `closeprobability`
- `sn_opportunitybulist`, `sn_productcategorylist`
- `sn_partnered`, `sn_primarypartnersengaged`
- `sn_strategic`, `sn_closequarter`
