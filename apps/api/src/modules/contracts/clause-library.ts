import type { ClauseCategory, ContractForm } from "@constructos/shared";

/**
 * Code-resident standard-form clause library (spec Domain C #193-224 subset).
 *
 * This is deliberately a typed constant, not a database table: the content of
 * FIDIC/NEC/JCT general conditions is fixed per edition, and modelling it in
 * code makes the time-bar engine (#225) auditable — a deadline can always be
 * traced to a specific, reviewable clause definition. Per-contract deviations
 * are handled by the Particular Conditions overlay on the contract record
 * (#201-202), never by mutating this library.
 *
 * `timeBarDays` is set ONLY where the form itself imposes a day-counted
 * notice deadline with a stated consequence (condition-precedent bars such as
 * FIDIC 20.2 / NEC 61.3, or relief-limiting clocks such as FIDIC 18.2).
 * Deadlines that run from a reference other than the event date (e.g. JCT's
 * Pay Less Notice, which counts backwards from the final date for payment)
 * are described in the summary but carry no `timeBarDays`, because computing
 * eventDate + N would be wrong.
 */

export type NoticeParty = "contractor" | "employer" | "administrator" | "either";
export type ObligationParty = "contractor" | "employer" | "administrator";

export interface ClauseDef {
  form: ContractForm;
  clauseRef: string;
  title: string;
  summary: string;
  category: ClauseCategory;
  /** days from the event/awareness date to the notice deadline, where the form imposes one */
  timeBarDays?: number;
  noticeBy?: NoticeParty;
  noticeRequired: boolean;
  /** continuing duty materialized into the obligation register on contract creation (#260) */
  standingObligation?: { party: ObligationParty; description: string };
}

/* ------------------------------------------------------------------ */
/* FIDIC Red Book 2017 (Conditions of Contract for Construction)       */
/* ------------------------------------------------------------------ */

const FIDIC_RED_2017: ClauseDef[] = [
  {
    form: "fidic_red_2017",
    clauseRef: "1.9",
    title: "Delayed Drawings or Instructions",
    summary:
      "If the Engineer fails to issue a drawing or instruction within a reasonable time after the Contractor has given notice that it is needed, and the Contractor suffers delay or cost as a result, the Contractor is entitled to EOT and/or Cost Plus Profit. The entitlement must be pursued as a claim under Sub-Clause 20.2.",
    category: "time",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "2.1",
    title: "Right of Access to the Site",
    summary:
      "The Employer must give the Contractor right of access to, and possession of, each part of the Site by the times stated in the Contract Data. Late access grounds a Contractor claim for EOT and/or Cost Plus Profit under Sub-Clause 20.2.",
    category: "time",
    noticeBy: "contractor",
    noticeRequired: true,
    standingObligation: {
      party: "employer",
      description:
        "Give the Contractor right of access to, and possession of, all parts of the Site within the times stated in the Contract Data.",
    },
  },
  {
    form: "fidic_red_2017",
    clauseRef: "3.7",
    title: "Agreement or Determination",
    summary:
      "For any matter referred under the Contract, the Engineer must consult with both Parties to try to reach agreement and, failing agreement within the time limit, issue a fair determination within 42 days. A determination not notified in time is deemed rejected and can be taken to dispute.",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "administrator",
      description:
        "Consult with both Parties on every matter referred for agreement or determination and, failing agreement, issue a fair, reasoned determination within the 42-day time limit.",
    },
  },
  {
    form: "fidic_red_2017",
    clauseRef: "4.1",
    title: "Contractor's General Obligations",
    summary:
      "The Contractor must execute the Works in accordance with the Contract and the Engineer's instructions, and remedy any defects, providing all superintendence, labour, plant, goods and temporary works required.",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Execute the Works in accordance with the Contract and the Engineer's instructions, and remedy any defects in the Works.",
    },
  },
  {
    form: "fidic_red_2017",
    clauseRef: "4.7",
    title: "Setting Out",
    summary:
      "The Contractor sets out the Works from the items of reference specified in the Contract. If an error in those reference items that an experienced contractor could not reasonably have discovered causes delay or cost, the Contractor is entitled to EOT and/or Cost Plus Profit, claimed under Sub-Clause 20.2.",
    category: "risk",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "4.12",
    title: "Unforeseeable Physical Conditions",
    summary:
      "The Contractor must give notice as soon as practicable on encountering physical conditions it considers Unforeseeable, describing them so the Engineer can inspect. Subject to a Sub-Clause 20.2 claim, the Contractor is entitled to EOT and Cost (no profit) to the extent the conditions were not reasonably foreseeable by an experienced contractor at the Base Date.",
    category: "risk",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "8.1",
    title: "Commencement of Works",
    summary:
      "The Engineer must give the Contractor not less than 14 days notice of the Commencement Date, which (unless otherwise stated) falls within 42 days of the Contractor receiving the Letter of Acceptance. The Contractor then starts as soon as reasonably practicable.",
    category: "time",
    noticeBy: "administrator",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "8.3",
    title: "Programme",
    summary:
      "The Contractor must submit an initial detailed programme within 28 days of the Commencement Date and a revised programme whenever the current one ceases to reflect actual progress or the Contractor's obligations. The Engineer may give a Notice of no-objection or state respects in which it fails to comply.",
    category: "time",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Submit the initial programme within 28 days of the Commencement Date and keep it current by submitting revised programmes whenever the accepted programme ceases to reflect actual progress.",
    },
  },
  {
    form: "fidic_red_2017",
    clauseRef: "8.4",
    title: "Advance Warning",
    summary:
      "Each Party must advise the other and the Engineer in advance of any known or probable future events or circumstances which may adversely affect the work of the Contractor's personnel, adversely affect performance of the completed Works, increase the Contract Price or delay execution. A no-fault early-warning duty new to the 2017 edition.",
    category: "notice",
    noticeBy: "either",
    noticeRequired: true,
    standingObligation: {
      party: "contractor",
      description:
        "Advise the Engineer and the Employer in advance of any known or probable future event which may adversely affect the work, increase the Contract Price or delay execution.",
    },
  },
  {
    form: "fidic_red_2017",
    clauseRef: "8.5",
    title: "Extension of Time for Completion",
    summary:
      "The Contractor is entitled to EOT to the extent completion is or will be delayed by Variations, causes of delay listed in the Conditions, exceptionally adverse climatic conditions, unforeseeable shortages of personnel or goods caused by epidemic or governmental action, or delay caused by the Employer's Personnel or authorities. Entitlement is conditional on a Sub-Clause 20.2 claim.",
    category: "time",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "8.8",
    title: "Delay Damages",
    summary:
      "If the Contractor fails to complete within the Time for Completion, the Employer is entitled to delay damages at the daily rate in the Contract Data, capped at the stated maximum, as the sole damages for late completion (save fraud, gross negligence or deliberate default). The Employer must itself claim these under Sub-Clause 20.2.",
    category: "time",
    noticeBy: "employer",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "13.1",
    title: "Right to Vary",
    summary:
      "The Engineer may initiate a Variation at any time before the Taking-Over Certificate for the Works, by instruction or by request for proposal. The Contractor is bound to execute it unless it promptly gives notice with the stated grounds of objection (e.g. the varied work was unforeseeable having regard to the scope, or the Goods cannot readily be obtained).",
    category: "variation",
    noticeRequired: false,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "13.3",
    title: "Variation Procedure",
    summary:
      "On a variation instruction the Contractor proceeds with the work and submits particulars of any programme impact and its proposed adjustment to the Contract Price. Agreement or determination of the adjustments follows the Sub-Clause 3.7 procedure.",
    category: "variation",
    noticeRequired: false,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "14.3",
    title: "Application for Interim Payment",
    summary:
      "After the end of each month the Contractor must submit a Statement showing in the prescribed sequence the amounts it considers itself entitled to, with supporting documents including the monthly progress report.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Submit a Statement after the end of each month showing the amounts considered due, with supporting particulars and the monthly progress report.",
    },
  },
  {
    form: "fidic_red_2017",
    clauseRef: "14.6",
    title: "Issue of Interim Payment Certificate",
    summary:
      "The Engineer must issue an Interim Payment Certificate within 28 days of receiving the Contractor's Statement and supporting documents, stating the amount fairly due with detailed supporting particulars for any difference from the Statement.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "administrator",
      description:
        "Issue each Interim Payment Certificate, with reasons for any difference from the Contractor's Statement, within 28 days of receiving the Statement and supporting documents.",
    },
  },
  {
    form: "fidic_red_2017",
    clauseRef: "14.7",
    title: "Payment",
    summary:
      "The Employer must pay the amount certified in each Interim Payment Certificate within 56 days after the Engineer receives the Contractor's Statement, and the Final Payment Certificate amount within 56 days of the Employer receiving it. This is the 28-day certification plus 56-day payment chain that fixes contractual cash-flow.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "employer",
      description:
        "Pay the amount certified in each Interim Payment Certificate within 56 days after the Engineer receives the Contractor's Statement and supporting documents.",
    },
  },
  {
    form: "fidic_red_2017",
    clauseRef: "14.8",
    title: "Delayed Payment",
    summary:
      "If a payment is not received on time the Contractor is entitled to financing charges compounded monthly on the unpaid amount, at 3% above the applicable borrowing/lending rate, accruing automatically without any formal notice or certification.",
    category: "payment",
    noticeRequired: false,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "15.2",
    title: "Termination for Contractor's Default",
    summary:
      "For the specified defaults (failure to remedy a notified breach, abandonment, failure to proceed, subcontracting the whole of the Works, insolvency, corrupt practices) the Employer may give a 14-day Notice of intention to terminate; for some grounds it may terminate immediately by a second Notice.",
    category: "termination",
    noticeBy: "employer",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "16.1",
    title: "Suspension by Contractor",
    summary:
      "If the Employer fails to pay a certified amount, fails to provide reasonable evidence of its financial arrangements, or the Engineer fails to certify, the Contractor may suspend or slow work after giving not less than 21 days notice, with entitlement to EOT and Cost Plus Profit for the consequences.",
    category: "termination",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "16.2",
    title: "Termination by Contractor",
    summary:
      "The Contractor may terminate on 14 days notice for the listed Employer defaults, including sustained non-payment of certified amounts, failure to provide financial-arrangement evidence, prolonged suspension affecting the whole Works, or Employer insolvency.",
    category: "termination",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "18.2",
    title: "Notice of an Exceptional Event",
    summary:
      "A Party prevented from performing by an Exceptional Event must give notice within 14 days of becoming aware (or when it should have become aware) of the event. If the notice is given later, relief from performance runs only from the date the notice is received rather than from the start of the prevention.",
    category: "notice",
    timeBarDays: 14,
    noticeBy: "either",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "20.2",
    title: "Claims for Payment and/or EOT — Notice of Claim",
    summary:
      "The claiming Party (Contractor or Employer — the 2017 bar is mutual) must give a Notice of Claim within 28 days of becoming aware, or when it should have become aware, of the event or circumstance. If the Notice is not given within 28 days, entitlement to additional payment or EOT is lost, subject only to the limited late-notice review in Sub-Clause 20.2.5.",
    category: "notice",
    timeBarDays: 28,
    noticeBy: "either",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "20.2.4",
    title: "Fully Detailed Claim",
    summary:
      "Within 84 days of when the claiming Party became (or should have become) aware of the event, it must submit a fully detailed claim stating the contractual and/or legal basis, with contemporary records and detailed supporting particulars of the amount and/or EOT claimed. If the statement of contractual basis is not submitted in time, the Notice of Claim is deemed to have lapsed.",
    category: "notice",
    timeBarDays: 84,
    noticeBy: "either",
    noticeRequired: true,
  },
  {
    form: "fidic_red_2017",
    clauseRef: "21.4",
    title: "Obtaining DAAB's Decision",
    summary:
      "Either Party may refer a dispute to the standing Dispute Avoidance/Adjudication Board, which must give its reasoned decision within 84 days. The decision is immediately binding; a Party dissatisfied with it must give a Notice of Dissatisfaction within 28 days, failing which the decision becomes final and binding.",
    category: "dispute",
    noticeBy: "either",
    noticeRequired: true,
  },
];

/* ------------------------------------------------------------------ */
/* FIDIC Red Book 1999 — key deltas from the 2017 edition              */
/* ------------------------------------------------------------------ */

const FIDIC_RED_1999: ClauseDef[] = [
  {
    form: "fidic_red_1999",
    clauseRef: "2.5",
    title: "Employer's Claims",
    summary:
      "The Employer must give notice and particulars of any claim for payment or an extension of the Defects Notification Period 'as soon as practicable' after becoming aware of the grounds. Unlike the Contractor's Sub-Clause 20.1, there is no fixed day-count bar — an asymmetry the 2017 edition removed by making Clause 20 mutual.",
    category: "notice",
    noticeBy: "employer",
    noticeRequired: true,
  },
  {
    form: "fidic_red_1999",
    clauseRef: "8.4",
    title: "Extension of Time for Completion",
    summary:
      "The Contractor is entitled to EOT for Variations, listed causes of delay, exceptionally adverse climatic conditions, unforeseeable shortages caused by epidemic or governmental actions, and delay or prevention by the Employer or authorities. Entitlement is conditional on a Sub-Clause 20.1 claim notice.",
    category: "time",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_red_1999",
    clauseRef: "13.1",
    title: "Right to Vary",
    summary:
      "The Engineer may initiate Variations at any time prior to the Taking-Over Certificate, by instruction or request for proposal, and the Contractor must execute each Variation unless it promptly notifies that it cannot readily obtain the Goods required.",
    category: "variation",
    noticeRequired: false,
  },
  {
    form: "fidic_red_1999",
    clauseRef: "14.7",
    title: "Payment",
    summary:
      "The Employer must pay each interim certified amount within 56 days after the Engineer receives the Contractor's Statement and supporting documents, and the final amount within 56 days of the Employer receiving the Final Payment Certificate.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "employer",
      description:
        "Pay each interim certified amount within 56 days after the Engineer receives the Contractor's Statement and supporting documents.",
    },
  },
  {
    form: "fidic_red_1999",
    clauseRef: "19.2",
    title: "Notice of Force Majeure",
    summary:
      "A Party prevented by Force Majeure must give notice specifying the event and the obligations prevented within 14 days of becoming aware (or when it should have become aware). Relief from performance applies only in respect of the period after a valid notice.",
    category: "notice",
    timeBarDays: 14,
    noticeBy: "either",
    noticeRequired: true,
  },
  {
    form: "fidic_red_1999",
    clauseRef: "20.1",
    title: "Contractor's Claims",
    summary:
      "The Contractor must give notice of any claim for EOT or additional payment within 28 days of becoming aware, or when it should have become aware, of the event or circumstance. The bar is an express condition precedent: without the notice, the Time for Completion is not extended, the Contractor is not entitled to additional payment, and the Employer is discharged. A fully detailed claim follows within 42 days.",
    category: "notice",
    timeBarDays: 28,
    noticeBy: "contractor",
    noticeRequired: true,
  },
];

/* ------------------------------------------------------------------ */
/* FIDIC Yellow Book 2017 — Red 2017 core plus design-risk clauses     */
/* ------------------------------------------------------------------ */

const FIDIC_YELLOW_2017: ClauseDef[] = [
  {
    form: "fidic_yellow_2017",
    clauseRef: "1.9",
    title: "Errors in the Employer's Requirements",
    summary:
      "On discovering an error, fault or defect in the Employer's Requirements the Contractor must give notice. To the extent an experienced contractor exercising due care would not have discovered it when scrutinising the Employer's Requirements, the Contractor is entitled to EOT and/or Cost Plus Profit, claimed under Sub-Clause 20.2.",
    category: "risk",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_yellow_2017",
    clauseRef: "4.1",
    title: "Contractor's General Obligations",
    summary:
      "The Contractor must design, execute and complete the Works in accordance with the Contract so that, when completed, they are fit for the purpose(s) for which they are intended as defined in the Employer's Requirements — a fitness-for-purpose obligation stricter than reasonable skill and care.",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Design, execute and complete the Works so that on completion they are fit for the purposes defined in the Employer's Requirements, and remedy any defects.",
    },
  },
  {
    form: "fidic_yellow_2017",
    clauseRef: "5.1",
    title: "General Design Obligations",
    summary:
      "The Contractor carries out and is responsible for the design of the Works using designers who satisfy the criteria in the Employer's Requirements, and is deemed to have scrutinised the Employer's Requirements (errors are dealt with under Sub-Clause 1.9).",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Carry out and remain responsible for the design of the Works using designers satisfying the criteria in the Employer's Requirements.",
    },
  },
  {
    form: "fidic_yellow_2017",
    clauseRef: "5.2",
    title: "Contractor's Documents",
    summary:
      "The Contractor must prepare and submit the Contractor's Documents specified in the Employer's Requirements for the Engineer's review, and must not begin construction of any related part of the Works before the review period has expired without a Notice of objection.",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Submit the Contractor's Documents for the Engineer's review and do not begin construction of the related work until the review period has passed without objection.",
    },
  },
  {
    form: "fidic_yellow_2017",
    clauseRef: "8.5",
    title: "Extension of Time for Completion",
    summary:
      "EOT entitlement for Variations, listed causes, exceptionally adverse climatic conditions, unforeseeable shortages from epidemic or governmental action, and Employer or authority delay — as in the Red Book 2017 — conditional on a Sub-Clause 20.2 claim.",
    category: "time",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_yellow_2017",
    clauseRef: "14.7",
    title: "Payment",
    summary:
      "The Employer must pay each Interim Payment Certificate amount within 56 days after the Engineer receives the Contractor's Statement, following the Engineer's 28-day certification duty — the same payment chain as the Red Book 2017.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "employer",
      description:
        "Pay the amount certified in each Interim Payment Certificate within 56 days after the Engineer receives the Contractor's Statement.",
    },
  },
  {
    form: "fidic_yellow_2017",
    clauseRef: "20.2",
    title: "Claims for Payment and/or EOT — Notice of Claim",
    summary:
      "Either Party claiming additional payment or EOT (or DNP extension) must give a Notice of Claim within 28 days of awareness, failing which the entitlement is lost, subject to the Sub-Clause 20.2.5 late-notice review. Identical mutual bar to the Red Book 2017.",
    category: "notice",
    timeBarDays: 28,
    noticeBy: "either",
    noticeRequired: true,
  },
  {
    form: "fidic_yellow_2017",
    clauseRef: "20.2.4",
    title: "Fully Detailed Claim",
    summary:
      "The claiming Party must submit its fully detailed claim, including the statement of contractual basis, within 84 days of awareness of the event, otherwise the Notice of Claim is deemed to have lapsed.",
    category: "notice",
    timeBarDays: 84,
    noticeBy: "either",
    noticeRequired: true,
  },
];

/* ------------------------------------------------------------------ */
/* FIDIC Silver Book 2017 (EPC/Turnkey) — risk-transfer deltas         */
/* ------------------------------------------------------------------ */

const FIDIC_SILVER_2017: ClauseDef[] = [
  {
    form: "fidic_silver_2017",
    clauseRef: "4.1",
    title: "Contractor's General Obligations",
    summary:
      "Single-point EPC responsibility: the Contractor designs, executes and completes the Works so that they are fit for the purposes defined in the Employer's Requirements, with virtually all completion risk carried by the Contractor. There is no Engineer — the Employer administers the Contract itself (through the Employer's Representative).",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Design, execute and complete the Works on a turnkey basis so that they are fit for the purposes defined in the Employer's Requirements.",
    },
  },
  {
    form: "fidic_silver_2017",
    clauseRef: "4.12",
    title: "Unforeseeable Difficulties",
    summary:
      "Except as otherwise stated, the Contractor is deemed to have obtained all necessary information about risks and difficulties, accepts total responsibility for having foreseen all difficulties and costs, and the Contract Price is not adjusted for unforeseen difficulties or costs — the decisive risk-transfer contrast with Red/Yellow 4.12.",
    category: "risk",
    noticeRequired: false,
  },
  {
    form: "fidic_silver_2017",
    clauseRef: "5.1",
    title: "General Design Obligations",
    summary:
      "The Contractor is responsible for the design and is deemed to have scrutinised the Employer's Requirements before the Base Date. The Employer is not responsible for any error, inaccuracy or omission in them, save for the narrow stated exceptions (defined immutable data, portions stated to be unverifiable, etc.).",
    category: "risk",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Remain responsible for the design of the Works, including the accuracy of the Employer's Requirements save for the limited stated exceptions.",
    },
  },
  {
    form: "fidic_silver_2017",
    clauseRef: "8.5",
    title: "Extension of Time for Completion",
    summary:
      "EOT entitlement is narrower than Red/Yellow — principally Variations, listed causes and Employer-caused delay; there is no relief route for unforeseeable physical conditions. Every entitlement remains conditional on a Sub-Clause 20.2 Notice of Claim.",
    category: "time",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "fidic_silver_2017",
    clauseRef: "14.7",
    title: "Payment",
    summary:
      "The Employer must pay each interim amount within 56 days after receiving the Contractor's Statement (there being no Engineer's certificate in the Silver Book), and the final amount within 56 days of the agreed Final Statement.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "employer",
      description:
        "Pay each interim amount due within 56 days after receiving the Contractor's Statement and supporting documents.",
    },
  },
  {
    form: "fidic_silver_2017",
    clauseRef: "20.2",
    title: "Claims for Payment and/or EOT — Notice of Claim",
    summary:
      "The mutual 28-day Notice of Claim bar applies: a Party that does not give notice within 28 days of when it became or should have become aware of the event loses its entitlement, subject only to the Sub-Clause 20.2.5 review.",
    category: "notice",
    timeBarDays: 28,
    noticeBy: "either",
    noticeRequired: true,
  },
  {
    form: "fidic_silver_2017",
    clauseRef: "20.2.4",
    title: "Fully Detailed Claim",
    summary:
      "A fully detailed claim with its statement of contractual basis must follow within 84 days of awareness, failing which the Notice of Claim is deemed to have lapsed.",
    category: "notice",
    timeBarDays: 84,
    noticeBy: "either",
    noticeRequired: true,
  },
];

/* ------------------------------------------------------------------ */
/* NEC4 Engineering and Construction Contract                          */
/* ------------------------------------------------------------------ */

const NEC4_ECC: ClauseDef[] = [
  {
    form: "nec4_ecc",
    clauseRef: "10.1",
    title: "Mutual Trust and Co-operation",
    summary:
      "The Parties, the Project Manager and the Supervisor must act as stated in the contract and (clause 10.2) in a spirit of mutual trust and co-operation. This is an enforceable obligation that colours every other clause, not a recital.",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Act as stated in the contract and in a spirit of mutual trust and co-operation in all dealings under it.",
    },
  },
  {
    form: "nec4_ecc",
    clauseRef: "13.1",
    title: "Communications",
    summary:
      "Every instruction, certificate, submission, notification and reply must be in a form which can be read, copied and recorded, and (clause 13.7) a notification required by the contract must be communicated separately from other communications — a burying-in-correspondence guard the courts have enforced.",
    category: "general",
    noticeRequired: false,
  },
  {
    form: "nec4_ecc",
    clauseRef: "15.1",
    title: "Early Warning",
    summary:
      "The Contractor and the Project Manager each notify an early warning as soon as they become aware of any matter which could increase the total of the Prices, delay Completion or a Key Date, or impair the performance of the works in use. Matters go on the Early Warning Register and meetings are convened; a Contractor's failure is sanctioned through clause 63.7 by assessing the compensation event as if the warning had been given.",
    category: "notice",
    noticeBy: "either",
    noticeRequired: true,
    standingObligation: {
      party: "contractor",
      description:
        "Notify an early warning as soon as aware of any matter which could increase the total of the Prices, delay Completion or a Key Date, or impair performance of the works in use, and attend early warning meetings.",
    },
  },
  {
    form: "nec4_ecc",
    clauseRef: "30.1",
    title: "Starting and Completion",
    summary:
      "The Contractor does not start work on the Site until the first access date and carries out the works so that Completion is on or before the Completion Date.",
    category: "time",
    noticeRequired: false,
  },
  {
    form: "nec4_ecc",
    clauseRef: "31.2",
    title: "The Programme",
    summary:
      "Each programme submitted for acceptance must show the starting date, access dates, Key Dates, Completion Date, planned Completion, the order and timing of operations, float, time risk allowances and the resources for each operation. The Project Manager accepts it or notifies reasons for rejection within two weeks; the Accepted Programme becomes the baseline for assessing compensation events.",
    category: "time",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Submit a first programme for acceptance showing the content required by clause 31.2, and maintain an Accepted Programme as the basis for managing the works.",
    },
  },
  {
    form: "nec4_ecc",
    clauseRef: "32.2",
    title: "Revised Programmes",
    summary:
      "The Contractor submits a revised programme when instructed by the Project Manager, when it chooses to, and in any case at intervals no longer than the period stated in the Contract Data, showing actual progress, the effects of implemented compensation events and how it plans to deal with delays.",
    category: "time",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Submit revised programmes at intervals no longer than the period stated in the Contract Data, showing actual progress and its effect on remaining work.",
    },
  },
  {
    form: "nec4_ecc",
    clauseRef: "50.3",
    title: "Application for Payment",
    summary:
      "The Contractor submits an application for payment before each assessment date. NEC4 adds a real sanction for not applying: if no application is made, the amount due is the lesser of the Project Manager's assessment and the amount last applied for or certified.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Submit an application for payment before each assessment date setting out the amount considered due.",
    },
  },
  {
    form: "nec4_ecc",
    clauseRef: "51.1",
    title: "Payment Certificate",
    summary:
      "The Project Manager certifies payment within one week of each assessment date, stating the amount due and the basis of its assessment.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "administrator",
      description: "Certify the amount due within one week of each assessment date.",
    },
  },
  {
    form: "nec4_ecc",
    clauseRef: "51.2",
    title: "Payment",
    summary:
      "Each certified payment is made within three weeks of the assessment date (or a different period stated in the Contract Data). Late payment attracts interest at the Contract Data rate, compounded annually.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "employer",
      description:
        "Make each certified payment within three weeks of the assessment date or the different period stated in the Contract Data.",
    },
  },
  {
    form: "nec4_ecc",
    clauseRef: "60.1",
    title: "Compensation Events",
    summary:
      "The exhaustive list of events which change the Prices, the Completion Date or a Key Date: Project Manager instructions changing the Scope, late access, unprovided things, physical conditions an experienced contractor would have judged to have such a small chance of occurring that allowing for them was unreasonable (60.1(12)), weather measured against a 1-in-10-year threshold (60.1(13)), Client and Others' failures, and the rest of the numbered list. If an event is not on the list (or added by secondary Options or Contract Data), it is the Contractor's risk.",
    category: "risk",
    noticeRequired: false,
  },
  {
    form: "nec4_ecc",
    clauseRef: "61.3",
    title: "Notifying Compensation Events",
    summary:
      "The Contractor notifies a compensation event within eight weeks (56 days) of becoming aware that the event has happened. If it fails to do so it is not entitled to a change in the Prices, the Completion Date or a Key Date — unless the event is one the Project Manager should have notified (e.g. one arising from an instruction). One of the strictest and most litigated time bars in standard-form contracting.",
    category: "notice",
    timeBarDays: 56,
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "nec4_ecc",
    clauseRef: "62.3",
    title: "Quotations for Compensation Events",
    summary:
      "The Contractor submits its quotation (changes to the Prices and any delay to the Completion Date, assessed on Defined Cost plus Fee) within three weeks of being instructed, and the Project Manager replies within two weeks. NEC4 adds a deemed-acceptance mechanism if the Project Manager fails to reply after the Contractor's reminder notification.",
    category: "variation",
    noticeRequired: false,
  },
  {
    form: "nec4_ecc",
    clauseRef: "63.1",
    title: "Assessing Compensation Events",
    summary:
      "Changes to the Prices are assessed as the effect of the event on the actual Defined Cost of work already done, the forecast Defined Cost of work not yet done, and the resulting Fee — not on tendered rates unless agreed. Delay is assessed as the length of time that planned Completion is later on the Accepted Programme.",
    category: "variation",
    noticeRequired: false,
  },
  {
    form: "nec4_ecc",
    clauseRef: "64.1",
    title: "Project Manager's Assessment",
    summary:
      "The Project Manager assesses a compensation event itself when the Contractor has not submitted a required quotation in time, has not assessed it correctly, or has no Accepted Programme (or has not submitted a required programme), notifying its assessment with details within the same period allowed to the Contractor.",
    category: "variation",
    noticeRequired: false,
  },
  {
    form: "nec4_ecc",
    clauseRef: "W1",
    title: "Dispute Resolution (non-UK) — Referral Windows",
    summary:
      "Where Option W1 applies, disputes must first be referred to the Senior Representatives and then to the Adjudicator strictly within the windows of the Dispute Reference Table; a dispute not referred within those times cannot subsequently be pursued. Tribunal proceedings require a notice of dissatisfaction within four weeks of the Adjudicator's decision.",
    category: "dispute",
    noticeBy: "either",
    noticeRequired: true,
  },
  {
    form: "nec4_ecc",
    clauseRef: "W2",
    title: "Dispute Resolution (UK HGCRA) — Adjudication",
    summary:
      "Where Option W2 applies (UK construction contracts), a Party may refer a dispute to the Adjudicator at any time, consistent with the statutory right to adjudicate. The decision is binding unless and until revised by the tribunal, and a notice of dissatisfaction must be given within four weeks to keep the matter alive.",
    category: "dispute",
    noticeBy: "either",
    noticeRequired: true,
  },
];

/* ------------------------------------------------------------------ */
/* NEC3 ECC — deltas from NEC4                                         */
/* ------------------------------------------------------------------ */

const NEC3_ECC: ClauseDef[] = [
  {
    form: "nec3_ecc",
    clauseRef: "10.1",
    title: "Actions — Mutual Trust and Co-operation",
    summary:
      "A single clause (split into 10.1/10.2 by NEC4) requiring the Employer, the Contractor, the Project Manager and the Supervisor to act as stated in the contract and in a spirit of mutual trust and co-operation.",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Act as stated in the contract and in a spirit of mutual trust and co-operation in all dealings under it.",
    },
  },
  {
    form: "nec3_ecc",
    clauseRef: "16.1",
    title: "Early Warning",
    summary:
      "NEC3's early-warning clause (renumbered 15.1 in NEC4): the Contractor and the Project Manager each notify an early warning as soon as aware of a matter which could increase the total of the Prices, delay Completion or a Key Date, or impair performance in use. Matters are entered in the Risk Register (NEC4 renamed it the Early Warning Register).",
    category: "notice",
    noticeBy: "either",
    noticeRequired: true,
    standingObligation: {
      party: "contractor",
      description:
        "Notify an early warning as soon as aware of any matter which could increase the total of the Prices, delay Completion or a Key Date, or impair performance of the works in use.",
    },
  },
  {
    form: "nec3_ecc",
    clauseRef: "31.2",
    title: "The Programme",
    summary:
      "The programme submitted for acceptance must show access dates, Key Dates, planned Completion, the order and timing of operations, float, time risk allowances and resource statements. The Project Manager accepts or gives reasons within two weeks, and the Accepted Programme anchors compensation-event assessment.",
    category: "time",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Submit and maintain programmes for acceptance showing the content required by clause 31.2.",
    },
  },
  {
    form: "nec3_ecc",
    clauseRef: "51.1",
    title: "Payment Certification and Payment",
    summary:
      "The Project Manager certifies payment within one week of each assessment date and payment follows within three weeks of the assessment date. In NEC3 the Project Manager must assess whether or not the Contractor has applied — there is no NEC4-style sanction reducing the amount due when no application is made.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "administrator",
      description: "Assess the amount due and certify payment within one week of each assessment date.",
    },
  },
  {
    form: "nec3_ecc",
    clauseRef: "61.3",
    title: "Notifying Compensation Events",
    summary:
      "The eight-week (56-day) condition-precedent bar introduced by NEC3: if the Contractor does not notify a compensation event within eight weeks of becoming aware of it, it is not entitled to a change in the Prices, the Completion Date or a Key Date, unless the Project Manager should have notified the event itself.",
    category: "notice",
    timeBarDays: 56,
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "nec3_ecc",
    clauseRef: "62.3",
    title: "Quotations for Compensation Events",
    summary:
      "The Contractor submits quotations within three weeks of being instructed and the Project Manager replies within two weeks. NEC3 lacks NEC4's reminder-plus-deemed-acceptance backstop, so a silent Project Manager historically had to be pursued through dispute procedures.",
    category: "variation",
    noticeRequired: false,
  },
];

/* ------------------------------------------------------------------ */
/* JCT Standard Building Contract 2016                                 */
/* ------------------------------------------------------------------ */

const JCT_SBC_2016: ClauseDef[] = [
  {
    form: "jct_sbc_2016",
    clauseRef: "1.7",
    title: "Notices and Communications",
    summary:
      "Sets how notices and other communications are given and when they take effect; communications may be by the agreed means, but notices under section 8 (termination) must be delivered by hand or sent by Recorded Signed for or Special Delivery post.",
    category: "general",
    noticeRequired: false,
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "2.27",
    title: "Notice of Delay",
    summary:
      "Whenever it becomes reasonably apparent that progress is being or is likely to be delayed, the Contractor must forthwith give written notice to the Architect/Contract Administrator identifying the material circumstances, the cause, and any event it considers a Relevant Event, followed by particulars of the expected effects. There is no day-counted bar, but late notice can depress the assessment because the CA judges the position as it stood.",
    category: "time",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "2.28",
    title: "Fixing the Completion Date",
    summary:
      "If a Relevant Event is likely to delay completion beyond the Completion Date, the Architect/CA must give an extension of time it estimates to be fair and reasonable, deciding as soon as reasonably practicable and in any event within 12 weeks of receiving the notice and required particulars. A final review follows within 12 weeks after practical completion.",
    category: "time",
    noticeRequired: false,
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "2.29",
    title: "Relevant Events",
    summary:
      "The list of events entitling the Contractor to an extension of time: Variations, instructions, deferment of possession, suspension for non-payment, impediment or default by the Employer, statutory undertakers' work, exceptionally adverse weather, loss by Specified Perils, strikes, changes in law, and force majeure.",
    category: "time",
    noticeRequired: false,
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "2.32",
    title: "Payment of Liquidated Damages",
    summary:
      "The Employer may deduct or require liquidated damages at the Contract Particulars rate only if the Architect/CA has issued a Non-Completion Certificate and the Employer has notified the Contractor before the final payment becomes due that it may require or deduct them — procedural preconditions the courts enforce strictly.",
    category: "risk",
    noticeBy: "employer",
    noticeRequired: true,
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "3.10",
    title: "Compliance with Instructions",
    summary:
      "The Contractor must comply forthwith with every instruction the Architect/CA is empowered to issue. If it does not comply within 7 days of a written compliance notice, the Employer may engage others to do the work and deduct the cost.",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Comply forthwith with all instructions properly issued by the Architect/Contract Administrator.",
    },
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "3.14",
    title: "Instructions Requiring Variations",
    summary:
      "The Architect/CA may issue instructions requiring a Variation, which is then valued under the Valuation Rules unless the Parties agree the value. The Contractor has a right of reasonable objection to variations of obligations or restrictions (access, working space, hours, sequence).",
    category: "variation",
    noticeRequired: false,
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "4.8",
    title: "Interim Payments — Due Dates and Certificates",
    summary:
      "Interim payments fall due monthly by reference to the Interim Valuation Dates, and the Architect/CA must issue an Interim Certificate no later than 5 days after each due date stating the sum it considers due and the basis of calculation.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "administrator",
      description:
        "Issue an Interim Certificate not later than 5 days after each monthly due date, stating the sum due and the basis on which it was calculated.",
    },
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "4.9",
    title: "Final Date for Payment and Pay Less Notice",
    summary:
      "The final date for payment of each certified sum is 14 days from its due date. An Employer intending to pay less than the certified sum must give a Pay Less Notice no later than 5 days before the final date, stating the sum it considers due and how it is calculated; without a valid notice the certified sum must be paid in full.",
    category: "payment",
    noticeBy: "employer",
    noticeRequired: true,
    standingObligation: {
      party: "employer",
      description:
        "Pay each certified sum by the final date for payment (14 days from the due date), or serve a compliant Pay Less Notice not later than 5 days before that final date.",
    },
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "4.20",
    title: "Loss and Expense",
    summary:
      "If regular progress is or is likely to be materially affected by a Relevant Matter, the Contractor must make its application promptly — as soon as the likely effect has become, or should have become, reasonably apparent — with an initial assessment of the loss and expense and updates at monthly intervals. The 2016 edition then obliges the Architect/CA to ascertain (initially within 28 days of the application).",
    category: "payment",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "4.21",
    title: "Relevant Matters",
    summary:
      "The list of matters entitling the Contractor to loss and expense: Variations, instructions, deferred possession, failure to give access, and any other impediment, prevention or default by the Employer or its representatives.",
    category: "payment",
    noticeRequired: false,
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "8.4",
    title: "Termination — Default by Contractor",
    summary:
      "For specified defaults (wholly or substantially suspending the Works without cause, failing to proceed regularly and diligently, refusing to remove defective work, unauthorised subletting, CDM breaches) the Architect/CA gives a default notice; if the default continues for 14 days the Employer may terminate the Contractor's employment by further notice within 21 days.",
    category: "termination",
    noticeBy: "employer",
    noticeRequired: true,
  },
  {
    form: "jct_sbc_2016",
    clauseRef: "8.9",
    title: "Termination — Default by Employer",
    summary:
      "The Contractor may give a default notice for Employer defaults — non-payment of a sum properly due, interference with the issue of certificates, unauthorised assignment, CDM breaches, or suspension of the Works exceeding the Contract Particulars period. If the default continues 14 days, the Contractor may terminate its employment by further notice.",
    category: "termination",
    noticeBy: "contractor",
    noticeRequired: true,
  },
];

/* ------------------------------------------------------------------ */
/* JCT Design and Build 2016 — deltas from SBC                         */
/* ------------------------------------------------------------------ */

const JCT_DB_2016: ClauseDef[] = [
  {
    form: "jct_db_2016",
    clauseRef: "2.17",
    title: "Design Liability",
    summary:
      "The Contractor completes the design of the Works but its liability is that of an architect or other appropriate professional designer — reasonable skill and care, not fitness for purpose — and, where applicable, is capped at the amount stated in the Contract Particulars for loss of use and similar heads.",
    category: "general",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Complete the design of the Works exercising the reasonable skill and care of a competent professional designer.",
    },
  },
  {
    form: "jct_db_2016",
    clauseRef: "2.24",
    title: "Notice of Delay",
    summary:
      "The DB counterpart of SBC 2.27: whenever progress is or is likely to be delayed the Contractor must forthwith notify the Employer (there being no Contract Administrator) of the circumstances and any Relevant Event, with particulars of the expected effects.",
    category: "time",
    noticeBy: "contractor",
    noticeRequired: true,
  },
  {
    form: "jct_db_2016",
    clauseRef: "2.25",
    title: "Fixing the Completion Date",
    summary:
      "The Employer must give a fair and reasonable extension of time for Relevant Events as soon as reasonably practicable and in any event within 12 weeks of receiving the Contractor's notice and reasonably sufficient particulars, with a post-practical-completion review.",
    category: "time",
    noticeRequired: false,
  },
  {
    form: "jct_db_2016",
    clauseRef: "3.9",
    title: "Instructions Requiring Changes",
    summary:
      "The Employer may issue instructions requiring a Change (the DB term for a Variation) to the Works or to imposed obligations and restrictions, valued under the Valuation Rules unless otherwise agreed. The Contractor has a right of reasonable objection to Changes to obligations or restrictions.",
    category: "variation",
    noticeRequired: false,
  },
  {
    form: "jct_db_2016",
    clauseRef: "4.7",
    title: "Interim Payments — Applications",
    summary:
      "Payment is driven by the Contractor's Interim Applications under Alternative A (stage payments) or Alternative B (periodic payments) as selected in the Contract Particulars — there are no certificates. The Employer must give a Payment Notice within 5 days of the due date and any Pay Less Notice not later than 5 days before the final date for payment.",
    category: "payment",
    noticeRequired: false,
    standingObligation: {
      party: "contractor",
      description:
        "Submit Interim Applications for payment under the selected Alternative (A: stages, B: periodic) with the details required to substantiate the sums applied for.",
    },
  },
  {
    form: "jct_db_2016",
    clauseRef: "4.19",
    title: "Loss and Expense",
    summary:
      "Mirrors SBC 4.20 but addressed to the Employer: the Contractor must apply promptly as soon as the likely effect of a Relevant Matter on regular progress becomes (or should have become) reasonably apparent, with an initial assessment and monthly updates, after which the Employer ascertains the amount.",
    category: "payment",
    noticeBy: "contractor",
    noticeRequired: true,
  },
];

/* ------------------------------------------------------------------ */

export const CLAUSE_LIBRARY: ClauseDef[] = [
  ...FIDIC_RED_2017,
  ...FIDIC_RED_1999,
  ...FIDIC_YELLOW_2017,
  ...FIDIC_SILVER_2017,
  ...NEC4_ECC,
  ...NEC3_ECC,
  ...JCT_SBC_2016,
  ...JCT_DB_2016,
];

/** All library clauses for a form ("bespoke" has none by definition). */
export function clausesForForm(form: ContractForm): ClauseDef[] {
  return CLAUSE_LIBRARY.filter((c) => c.form === form);
}

/** Resolve a clause by form + ref (exact match). */
export function findClause(form: ContractForm, clauseRef: string): ClauseDef | undefined {
  return CLAUSE_LIBRARY.find((c) => c.form === form && c.clauseRef === clauseRef);
}
