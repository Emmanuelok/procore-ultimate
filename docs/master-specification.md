# THE COMPLETE CONSTRUCTION PLATFORM FUNCTIONAL SPECIFICATION

## Volume I — Procore Feature Inventory (Exhaustive)
## Volume II — The Gap Map: What Procore Structurally Cannot Cover
## Volume III — Build Architecture & Module Prioritisation

**Prepared for:** Elkings
**Date:** 18 August 2026
**Status:** Master build reference — nothing withheld
**Basis:** Procore product catalogue as published August 2026, plus documented user-reported behaviour, plus first-principles domain analysis of international construction, quantity surveying, procurement-integrity and capital-programme practice.

---

## HOW TO READ THIS DOCUMENT

Volume I is a **parity checklist**. Every line is a thing Procore does. If you intend to compete anywhere near their turf, every unticked line is a sales objection waiting to happen.

Volume II is the **actual product**. It enumerates capabilities that are absent from Procore, and — critically — separates two very different kinds of absence:

- **Roadmap gaps (R)** — they haven't built it yet, but they will. Do not build a business on these. You will be overrun within 18 months.
- **Structural gaps (S)** — they *cannot* build it without damaging their core business model, contradicting their customer's interests, or rewriting their data architecture. These are permanently defensible. Build here.
- **Geographic/regulatory gaps (G)** — absent because their market is North America. Buildable by them in principle, unattractive in practice because of margin per unit of engineering effort.

Volume III converts the gap map into a module architecture with a build sequence.

Counts: Volume I enumerates **1,180+ discrete functions** across 61 modules. Volume II enumerates **740+ absent functions** across 26 domains.

---

---

# VOLUME I — PROCORE COMPLETE FUNCTIONAL INVENTORY

---

## SECTION 0 — PLATFORM FOUNDATIONS

These are the substrate. Every module inherits from them. Under-building this layer is the single most common reason challenger platforms die at customer #40.

### 0.1 Identity, Access & Tenancy

1. Company-level account (tenant) as top-level container
2. Multi-company support for users belonging to several firms
3. Company-to-company connection / linked accounts
4. Project-level containers nested under company
5. Project templates — clone configuration, permissions, folder structure, workflows
6. Sandbox / training environment provisioning
7. User directory at company level
8. Project-specific user directory with add/remove per project
9. Contact records distinct from user records (non-login contacts)
10. Vendor/company directory with trade classification
11. Vendor merge and de-duplication
12. Distribution groups (named recipient lists reusable across tools)
13. Role-based permission templates
14. Granular per-tool permission levels (None / Read Only / Standard / Admin)
15. Item-level permission overrides
16. Permission propagation preview before commit
17. Directory-based permission assignment by role
18. Field-level visibility control on financial data
19. Private/confidential document flagging
20. Single Sign-On (SAML 2.0)
21. SCIM user provisioning and de-provisioning
22. Multi-factor authentication enforcement
23. Session timeout policy configuration
24. IP allowlisting for enterprise tenants
25. Password policy configuration
26. Login audit trail
27. Delegated administration
28. Guest / limited external collaborator access
29. Subcontractor portal access at no seat cost
30. Owner/architect stakeholder access tiers

### 0.2 Data Residency, Security & Compliance

31. Regional data hosting zones ("Procore Zones")
32. Encryption at rest
33. Encryption in transit
34. SOC 1 Type II attestation
35. SOC 2 Type II attestation
36. ISO 27001 certification
37. GDPR compliance tooling and DPA
38. CCPA / California consumer rights handling
39. FedRAMP Class C authorisation for the Government edition
40. CMMC Level 2 support posture for DoD contractors
41. Penetration testing programme and disclosure
42. Sub-processor register publication
43. AI transparency portal — model inventory, data flow disclosure
44. Audit log of record changes (who/what/when)
45. Data export on contract termination
46. Retention policy configuration
47. Legal hold capability
48. Privacy-by-design data governance controls

### 0.3 Core Object Model

49. Project object with lifecycle stage attribute
50. Project stages (bidding, pre-construction, course of construction, warranty, closed)
51. Project types and departments for classification
52. Portfolio grouping of projects
53. Programme grouping above portfolio
54. Locations — hierarchical, multi-tier (building > level > zone > room)
55. Location assignment on any record type
56. Cost codes — company standard list
57. Cost code project overrides
58. WBS (Work Breakdown Structure) with configurable segments
59. WBS segment types (cost code, cost type, sub-job, custom)
60. Sub-jobs / phases for cost segregation
61. Cost types (labour, material, equipment, subcontract, other)
62. Custom fieldsets across most tools
63. Custom field types (text, number, date, dropdown, multi-select, checkbox, currency, lookup)
64. Configurable fieldsets per project
65. Custom tool builder for bespoke record types
66. Tags and labels
67. Attachment model shared across all record types
68. Comment/discussion threads on records
69. @mention notifications within comments
70. Watchers / followers on records
71. Record status lifecycle with configurable states
72. Record numbering schemes with auto-increment
73. Cross-tool linking (RFI to drawing to submittal to change event)
74. Global search across tools
75. Advanced filtering with saved filter sets
76. Bulk edit across record sets
77. Bulk import via CSV/Excel templates
78. Recycle bin / soft delete with restore

### 0.4 Workflow Engine

79. Configurable approval workflows
80. Multi-step sequential approval chains
81. Parallel approval steps
82. Conditional branching on field values
83. Role-based step assignment
84. Named-individual step assignment
85. Due date and escalation rules per step
86. Automatic reminders on overdue steps
87. Delegation of approval authority
88. Workflow template library
89. Workflow versioning
90. Retroactive template updates across live projects
91. Workflow status visualisation
92. Workflow audit history

### 0.5 Notifications & Communication

93. Email notification engine with per-user preferences
94. In-app notification centre
95. Push notifications to mobile
96. Digest / summary email options
97. Notification muting per project or tool
98. **Conversations** — unified messaging tying current and historic threads to project records
99. Inbound email-to-record capture
100. Distribution list management per tool
101. Correspondence tool for typed, trackable letters
102. Transmittals with formal issue records
103. Read receipts on formal issues

### 0.6 Mobile & Field

104. iOS native application
105. Android native application
106. Offline mode with local caching
107. Offline record creation and queued sync
108. Conflict resolution on re-connection
109. Selective project download for offline use
110. Camera capture directly into records
111. Voice-to-text field entry
112. Barcode / QR scanning
113. GPS tagging of field records
114. Mobile drawing viewer with pinch-zoom and markup
115. Mobile BIM model viewer
116. Tablet-optimised layouts
117. Wearable / rugged device support
118. Low-bandwidth mode

### 0.7 Integration & Extensibility

119. REST API with documented endpoints
120. OAuth 2.0 authentication for third-party apps
121. Webhooks for event-driven integration
122. Rate limiting and quota management
123. Developer sandbox environment
124. **App Marketplace with 500+ integrations**
125. Managed Marketplace governance tier
126. **Agentic APIs** — retrieval, MCP and agentic workflow access for third-party AI builders
127. MCP (Model Context Protocol) server exposure
128. Embedded Experience — third-party UI surfaced inside Procore
129. Procore Extensions / custom solutions framework
130. ERP connector framework
131. Sage 100 / 300 CRE connectors
132. Viewpoint Vista / Spectrum connectors
133. QuickBooks connector
134. Oracle Primavera P6 integration
135. Microsoft Project integration
136. Bluebeam integration
137. Autodesk / BIM 360 data exchange
138. Smartsheet integration
139. Zoom integration
140. Data warehouse / analytics connector for BI tools
141. Custom reports API
142. Bulk data export

### 0.8 Configuration & Administration

143. Company admin console
144. Project admin console
145. Tool enable/disable per project
146. Configurable tool naming
147. Custom project layouts and dashboards
148. Portfolio layout customisation
149. Company-wide standard templates
150. Training Center — customisable SOP documentation overlaid on help content
151. Certification programme and learning management
152. Support ticketing with unlimited access
153. Community forum
154. Release notes and product update feed

---

## SECTION 1 — PRECONSTRUCTION

### 1.1 Bid Management

155. Bid package creation
156. Scope-of-work definition per package
157. Bidder list assembly from vendor directory
158. Bidder invitation distribution
159. Bid invitation email templates
160. Bid response tracking (invited / viewed / intending / submitted / declined)
161. Bid coverage analysis by trade
162. Automated follow-up reminders to non-responders
163. Bid form templates with line-item structure
164. Online bid submission portal for subcontractors
165. Sealed bid handling with timed release
166. Bid due date and countdown management
167. Addenda issue and acknowledgement tracking
168. Drawing and specification distribution to bidders
169. Document access logging per bidder
170. Bid levelling / comparison sheet
171. Side-by-side quote comparison
172. Scope gap identification across bids
173. Inclusion / exclusion capture
174. Alternates and options pricing
175. Unit rate capture on bid lines
176. Bid adjustment and normalisation notes
177. Bid award and conversion to commitment
178. Unsuccessful bidder notification
179. Bid history retention per vendor
180. Public / private bid board publication
181. Pre-bid meeting scheduling and attendance
182. RFI handling during bid period
183. Bid bond tracking

### 1.2 Estimating

184. Digital plan takeoff from PDF drawings
185. Linear measurement tools
186. Area measurement tools
187. Volume/count measurement tools
188. Scale calibration per sheet
189. Takeoff layers with colour coding
190. Takeoff item assignment to cost codes
191. Assembly-based takeoff
192. Cost catalogue / item database
193. Custom assembly creation
194. Labour unit / production rate library
195. Material pricing library
196. Equipment rate library
197. Crew composition definitions
198. Markup application (overhead, profit, contingency)
199. Tiered markup by cost type
200. Estimate versioning
201. Estimate comparison across versions
202. Sub-quote import into estimate lines
203. Bid levelling feed into estimate
204. Estimate-to-budget conversion
205. Proposal generation from estimate
206. Estimate export to Excel
207. Historical cost data reference
208. Change order estimating

### 1.3 Prequalification

209. Prequalification questionnaire builder
210. Custom question sets by trade
211. Vendor self-service submission portal
212. Financial statement collection
213. Bonding capacity capture (single project and aggregate)
214. Insurance certificate collection
215. Insurance expiry tracking and alerts
216. EMR (Experience Modification Rate) capture
217. Safety record and incident rate capture
218. OSHA / regulatory citation history
219. Licensing and registration verification
220. Reference collection and checking
221. Trade and geography capability tagging
222. Scoring model with weighted criteria
223. Automatic qualification tiering
224. Risk rating assignment
225. Approval workflow for prequalification
226. Re-qualification cycle and expiry management
227. Prequalified vendor pool filtering for bid invitations
228. Diversity / minority-business classification capture
229. Prequalification document repository
230. Vendor performance history link

### 1.4 BIM

231. Model upload (IFC, RVT, NWD and related)
232. Model federation across disciplines
233. Web-based model viewer
234. Mobile model viewer
235. Model element property inspection
236. Model versioning and revision comparison
237. Model-to-drawing linking
238. Model-to-schedule linking (4D)
239. Model-to-cost linking (5D, partial)
240. Clash detection review and issue tracking
241. Coordination issue assignment and resolution
242. Model markup and annotation
243. Section and cut plane tools
244. Measurement in 3D
245. Model element to RFI / observation linking
246. Reality capture overlay against model
247. 3D streaming for large federated models
248. Model-based location assignment

### 1.5 Design Coordination

249. Design review cycles
250. Design issue register
251. Discipline-based issue routing
252. Design decision log
253. Design package tracking
254. Consultant deliverable tracking
255. Design change notification

---
## SECTION 2 — PROJECT EXECUTION

### 2.1 Drawings

256. Bulk drawing set upload (PDF)
257. **OCR extraction of sheet number and title** — automatic sheet naming
258. Sheet naming review and correction queue
259. Drawing set versioning with revision history
260. Current-set enforcement (only latest is default-visible)
261. Superseded drawing archive with access
262. Revision comparison / visual diff overlay
263. Automatic hyperlinking of detail callouts between sheets
264. Manual hyperlink creation
265. Drawing area / building segregation
266. Discipline categorisation
267. Drawing markup tools (pen, shapes, text, cloud, stamp)
268. Personal vs published markup layers
269. Markup persistence across revisions
270. Markup attribution by author
271. Measurement tools on drawings with calibration
272. Drawing-to-RFI linking with pin placement
273. Drawing-to-submittal linking
274. Drawing-to-punch item pin placement
275. Drawing-to-observation pin placement
276. Drawing-to-photo pin placement
277. Drawing comparison against model
278. Drawing download for offline
279. Drawing print / export with markups
280. Drawing distribution and issue notification
281. Drawing log report
282. Sheet-level permission control

### 2.2 Specifications

283. Specification book upload and division parsing
284. Automatic section number and title extraction
285. Specification section versioning
286. Specification-to-submittal linking
287. Specification search across full text
288. Specification revision tracking
289. Division/section browse tree

### 2.3 Documents

290. Folder tree with unlimited nesting
291. Folder-level permissions
292. File versioning with history
293. File check-in / check-out
294. In-browser preview of common file types
295. Bulk upload and drag-drop
296. File move / copy / rename
297. Private file flagging
298. Document search by name and metadata
299. Download tracking
300. Email-to-folder ingestion
301. Storage without hard cap

### 2.4 RFIs (Requests for Information)

302. RFI creation with auto-numbering
303. RFI draft state before issue
304. Question and proposed-solution fields
305. Assignee and ball-in-court tracking
306. Distribution list per RFI
307. Due date with configurable default lead time
308. Overdue flagging and escalation
309. Official response capture
310. Multiple response consolidation
311. RFI response approval workflow
312. Cost impact flag (yes / no / TBD)
313. Schedule impact flag with day count
314. RFI-to-change-event conversion
315. RFI-to-drawing pin linkage
316. RFI-to-specification linkage
317. RFI-to-submittal linkage
318. RFI reference to prior RFIs
319. RFI attachment handling
320. RFI log with filtering and export
321. RFI ageing report
322. RFI cycle-time analytics
323. Subcontractor-initiated RFIs
324. RFI email ingestion
325. Private RFI drafts

### 2.5 Submittals

326. Submittal register generation from specification sections
327. Submittal package grouping
328. Submittal type classification (shop drawing, product data, sample, mock-up, O&M, warranty, certificate)
329. Submittal numbering with revision suffix
330. Ball-in-court routing
331. Sequential approval chains
332. Parallel reviewer support
333. Reviewer response codes (approved, approved as noted, revise and resubmit, rejected, for record)
334. Configurable response code sets
335. Required-on-site date
336. Lead time capture
337. Backward-scheduling from required date
338. Submittal schedule generation
339. Overdue and at-risk flagging
340. Resubmittal chain tracking
341. Markup on submitted documents
342. Submittal-to-specification linkage
343. Submittal-to-drawing linkage
344. Submittal-to-schedule task linkage
345. Distribution on approval
346. Submittal log with filtering and export
347. Submittal turnaround analytics
348. Closeout submittal segregation

### 2.6 Schedule

349. Schedule import from Primavera P6 (XER)
350. Schedule import from Microsoft Project (MPP/XML)
351. Native schedule creation and editing
352. Gantt chart visualisation
353. Critical path display
354. Task dependencies (FS, SS, FF, SF) with lag
355. Baseline capture
356. Baseline vs actual variance display
357. Schedule versioning and comparison
358. Task-level percentage complete
359. Lookahead schedule generation (3-week, 6-week)
360. Task assignment to responsible parties
361. Field-updatable task progress
362. Schedule-to-submittal linkage with conflict alerting
363. Schedule-to-RFI linkage
364. Schedule-to-inspection linkage
365. Schedule-to-action-plan linkage
366. Milestone tracking
367. Calendar view
368. Schedule change notification to distribution list
369. Schedule narrative attachment
370. Resource-loaded task support
371. Schedule health indicators

### 2.7 Daily Log

372. Daily log entry by date
373. Weather auto-capture from location and date
374. Manual weather override
375. Temperature, precipitation, wind capture
376. Manpower log by company and headcount
377. Hours worked per company
378. Equipment on site log
379. Equipment hours (operating / idle)
380. Material deliveries log
381. Visitor log
382. Inspection log entry
383. Delay log with cause classification
384. Safety violation log
385. Accident/incident log entry
386. Quantity installed log
387. Waste log
388. Dumpster / disposal log
389. Call log
390. Notes and general observations
391. Photo attachment to log entries
392. Daily log approval workflow
393. Daily log distribution
394. Daily log PDF export
395. Missing-log detection and reminder
396. Subcontractor self-reported daily logs
397. Log entry templates

### 2.8 Punch List

398. Punch item creation
399. Punch item type classification
400. Trade / responsible party assignment
401. Location assignment
402. Drawing pin placement
403. Photo attachment (before / after)
404. Due date and priority
405. Punch list templates
406. Bulk punch item creation
407. Final approver / verifier role
408. Multi-stage sign-off (assignee complete > verifier approve)
409. Distribution to subcontractors
410. Punch list by trade export
411. Punch item ageing report
412. Punch completion analytics
413. Room/area-based punch walk mode
414. Offline punch capture

### 2.9 Meetings

415. Meeting creation with agenda
416. Agenda item templates
417. Attendee list with attendance capture
418. Meeting minute recording per item
419. Carry-forward of open items to next meeting
420. Action item assignment with due date
421. Meeting series / recurrence
422. Minutes distribution
423. Minutes approval workflow
424. Meeting-to-RFI/change linkage
425. Meeting export to PDF

### 2.10 Photos & Videos

426. Photo upload from mobile and desktop
427. Album organisation
428. Automatic date/time stamping
429. GPS location capture
430. Location tagging to project location tree
431. Drawing pin placement of photos
432. Photo markup and annotation
433. Photo-to-record linkage (RFI, observation, punch, daily log)
434. Bulk download
435. Video upload and playback
436. 360-degree photo support
437. **AI photo intelligence — automatic tagging, progress summarisation, safety signal detection from images**
438. Photo search by tag and metadata
439. Privacy/permission control on albums

### 2.11 Correspondence & Transmittals

440. Custom correspondence types
441. Formal letter creation with numbering
442. Transmittal creation and issue
443. Recipient acknowledgement tracking
444. Correspondence register
445. Configurable correspondence workflows
446. Response tracking with due dates

### 2.12 Action Plans

447. Action plan template creation
448. Required activity definition per plan
449. Evidence requirement per activity
450. Reference document attachment
451. Sign-off requirement configuration
452. Multi-party sign-off
453. Plan assignment to location or schedule task
454. Progress tracking against plan
455. Plan completion reporting
456. Quality control checkpoint enforcement

### 2.13 Forms

457. Fillable PDF form upload
458. Form field mapping
459. Simple to complex form logic
460. Form assignment and distribution
461. Mobile form completion
462. Signature capture
463. Form register and export
464. Form templates library

### 2.14 Coordination Issues

465. Issue creation from model or drawing
466. Discipline assignment
467. Issue status lifecycle
468. Issue-to-model-element linkage
469. Issue-to-RFI escalation
470. Issue register and export

### 2.15 Maps & Locations

471. Integrated map view of project assets
472. Geofence definition
473. Filter by geofence
474. Equipment fleet map view
475. Observation and inspection map placement
476. Photo and drawing geolocation
477. Historical location timeline
478. 2D / 3D / map mode switching with AI-assisted asset location

---

## SECTION 3 — COST & FINANCIAL MANAGEMENT

### 3.1 Budget

479. Budget creation from cost code structure
480. Budget import from estimate
481. Budget import from ERP
482. Original budget lock
483. Budget line items by WBS segment
484. Budget modifications with approval
485. Budget transfers between line items
486. Budget view configuration (custom columns and calculations)
487. Multiple budget views per project
488. Snapshot capture of budget at points in time
489. Snapshot comparison
490. Forecast-to-complete calculation
491. Manual forecast override per line
492. Estimated cost at completion (EAC)
493. Projected over/under by line and total
494. Committed vs uncommitted cost display
495. Direct cost roll-up into budget
496. Job-to-date cost display
497. Budget vs actual variance reporting
498. Budget change history audit
499. Contingency line management
500. Budget detail drill-down to source transactions

### 3.2 Prime Contract (Owner Contract)

501. Prime contract record creation
502. Contract value and schedule of values
503. SOV line items with cost code mapping
504. Contract document attachment
505. Executed date and key dates
506. Retention/retainage percentage configuration
507. Retention by line item
508. Contract change order register
509. Potential change order (PCO) tracking
510. Change order request (COR) to owner
511. Owner approval workflow
512. Revised contract value calculation
513. Prime contract invoicing (owner billing)
514. AIA G702/G703 style application for payment
515. Progress billing by SOV line
516. Stored materials billing
517. Retention release management
518. Payment receipt tracking
519. Contract compliance document tracking

### 3.3 Commitments (Subcontracts & Purchase Orders)

520. Subcontract record creation
521. Purchase order record creation
522. Commitment schedule of values
523. Line item cost code assignment
524. Commitment value and revised value tracking
525. Contract document generation from template
526. Digital signature routing
527. Executed contract storage
528. Scope of work attachment
529. Exhibits and attachments management
530. Insurance requirement tracking per commitment
531. Bond requirement tracking
532. Compliance document expiry alerting
533. Commitment change order register
534. Commitment status lifecycle
535. Commitment-to-budget linkage
536. Commitment payment tracking
537. Retention held per commitment
538. Backcharge recording
539. Commitment closeout and final release

### 3.4 Change Management

540. Change event creation as central intake
541. Change event from RFI
542. Change event from observation
543. Change event from daily log delay
544. Change event from meeting item
545. Change event cost estimation (rough order of magnitude)
546. Change event line items by cost code
547. Change event status (open, pending, closed, void)
548. Request for quote (RFQ) to subcontractors from change event
549. Subcontractor quote collection and comparison
550. Potential change order (PCO) creation
551. PCO to prime change order (owner-facing) conversion
552. PCO to commitment change order (sub-facing) conversion
553. Markup application on change orders
554. Tiered markup configuration
555. Change order approval workflow
556. Change order numbering and packaging
557. Multiple PCOs bundled into one change order
558. Schedule impact days capture
559. Change order log with status filtering
560. Change order ageing report
561. Change order cycle time analytics
562. Change order value as % of contract reporting
563. Two-tier and three-tier change configuration
564. Change history audit trail

### 3.5 Invoicing & Billing

565. Owner invoice (progress billing) creation
566. Billing period configuration
567. Subcontractor invoice submission portal
568. Subcontractor self-service invoice entry
569. Invoice against SOV lines with % complete
570. Stored materials line handling
571. Retention calculation and display
572. Invoice review and approval workflow
573. Line-item level approval/rejection
574. Invoice revision and resubmission
575. Compliance hold on invoice (expired insurance blocks payment)
576. Lien waiver requirement per invoice
577. Conditional and unconditional lien waiver generation
578. Lien waiver e-signature collection
579. Invoice-to-payment application roll-up
580. Direct cost entry (labour, material, expense)
581. Timecard cost roll-up to job cost
582. Invoice export to ERP
583. Payment status tracking
584. Invoice log and ageing report
585. Billing summary reports

### 3.6 Procore Pay

586. Integrated subcontractor payment disbursement
587. Bank account verification for payees
588. Payment scheduling
589. **Lien waiver automation tied to payment release**
590. Compliance checklist enforcement before disbursement
591. Payment status transparency to subcontractor
592. Payment history and remittance advice
593. Multi-tier payment visibility
594. Payment reconciliation reporting

### 3.7 Time & Material Tickets

595. T&M ticket creation in field
596. Labour hours capture by worker/crew
597. Equipment hours capture
598. Material quantity capture
599. Rate application from agreed schedule
600. Signature capture from owner/GC representative
601. Photo evidence attachment
602. T&M ticket approval workflow
603. T&M to change event conversion
604. T&M ticket register and export

### 3.8 Timecard & Labour Cost

605. Individual timecard entry
606. Crew-based bulk time entry
607. Time entry by cost code
608. Time entry by location
609. Clock-in / clock-out with GPS
610. Break and meal period tracking
611. Overtime rule configuration
612. Timecard approval workflow
613. Timecard export to payroll
614. Labour cost roll-up to budget
615. Labour productivity rate calculation
616. Certified payroll data capture (US Davis-Bacon)

---

## SECTION 4 — QUALITY & SAFETY

### 4.1 Inspections

617. Inspection template builder
618. Checklist item creation with response types
619. Pass / fail / N-A response handling
620. Conditional follow-up items
621. Photo requirement per item
622. Signature requirement per item
623. Inspection scheduling and recurrence
624. Inspection assignment
625. Location-based inspection
626. Drawing pin placement of inspection
627. Failed item to observation conversion
628. Corrective action tracking
629. Inspection completion sign-off
630. Inspection register and export
631. Inspection template library by type (quality, safety, commissioning, environmental)
632. Third-party / authority inspection recording
633. Inspection pass-rate analytics

### 4.2 Observations

634. Observation creation (quality, safety, commissioning, warranty, work-to-complete)
635. Observation type configuration
636. Priority and severity classification
637. Assignee and due date
638. Location and drawing pin
639. Photo evidence before / after
640. Corrective action description
641. Observation status lifecycle
642. Verification and closure by initiator
643. Escalation on overdue
644. Observation-to-change-event conversion
645. Observation register and export
646. Observation trend analytics by trade and type

### 4.3 Incidents

647. Incident record creation
648. Incident classification (injury, illness, near miss, property damage, environmental)
649. Injured person record
650. Body part and injury type coding
651. Treatment level classification (first aid, medical, restricted, lost time)
652. **OSHA recordability determination and 300/300A/301 log generation**
653. Witness statements
654. Root cause analysis fields
655. Corrective and preventive action tracking
656. Incident investigation workflow
657. Photo and document evidence
658. Regulatory notification tracking
659. Incident register and export
660. TRIR / DART / LTIFR rate calculation
661. Incident trend analytics
662. Near-miss reporting encouragement workflow

### 4.4 Safety Programme Tools

663. Toolbox talk library
664. Toolbox talk delivery and attendance capture
665. Signature collection on safety briefings
666. Job hazard analysis (JHA) / safe work method statements
667. Permit-to-work issuance (hot work, confined space, lifting, excavation)
668. Permit expiry and closure tracking
669. Safety orientation tracking per worker
670. Certification and training expiry tracking
671. Safety observation card programme
672. Crane and lift plan recording
673. Emergency contact and procedure repository
674. Safety analytics dashboard
675. Leading vs lagging indicator reporting

---

## SECTION 5 — RESOURCE MANAGEMENT

### 5.1 Resource Planning

676. Workforce availability calendar
677. Skill and certification profile per worker
678. Crew composition and assignment
679. Assignment to project and date range
680. Drag-and-drop resource scheduling board
681. Over-allocation detection
682. Forecast labour demand by project
683. Aggregate demand vs supply view across portfolio
684. Gap and surplus identification
685. Assignment notification to workers
686. Assignment change history
687. Sub-contract labour tracking
688. Resource utilisation reporting

### 5.2 Resource Tracking / Field Productivity

689. Planned vs installed quantity tracking
690. Unit rate productivity measurement
691. Earned value by cost code
692. Productivity factor (PF) calculation
693. Cost performance index reporting
694. Labour hours vs budget hours by activity
695. Field-reported progress capture
696. Crew-level productivity comparison
697. Productivity trend charting
698. Forecast completion based on current productivity
699. Alerting on productivity deviation

### 5.3 Equipment

700. Equipment asset register
701. Equipment categorisation and specification
702. Ownership vs rental classification
703. Assignment to project
704. Check-in / check-out
705. Utilisation hours logging
706. Idle time tracking
707. Telematics integration
708. GPS location tracking and map view
709. Maintenance schedule definition
710. Preventive maintenance alerting
711. Inspection requirement per asset
712. Service history log
713. Fuel and consumable logging
714. Equipment cost rate and charge-out
715. Equipment cost allocation to job
716. Rental period and return tracking
717. Equipment availability calendar
718. Equipment transfer between projects

### 5.4 Materials

719. Material order tracking from purchase order
720. Expected delivery date management
721. Delivery confirmation and receipt
722. Partial delivery handling
723. Quantity received vs ordered reconciliation
724. Material storage location assignment
725. Installed quantity tracking against delivered
726. Material shortage alerting
727. Delayed shipment impact flagging
728. Material-to-schedule task linkage
729. Material status on map view
730. Supplier performance tracking

---

## SECTION 6 — ANALYTICS, REPORTING & INTELLIGENCE

### 6.1 360 Reporting

731. Cross-tool custom report builder
732. Column selection across linked objects
733. Filter and grouping configuration
734. Calculated columns
735. Pre-built editable report templates
736. Report scheduling and email delivery
737. Report sharing and permissions
738. Export to PDF, CSV, Excel
739. Project-level and company-level report scope
740. Inactive project tracking

### 6.2 Analytics 2.0

741. Pre-built dashboards by role
742. Custom dashboard creation
743. Data model exposed for BI tool connection
744. Portfolio-level aggregation
745. Trend analysis across projects
746. **Predictive fields exposed as data columns**
747. Predicted project spend
748. Predicted schedule risk
749. Drill-through from chart to record
750. Historical comparison
751. Row-level security in analytics
752. Scheduled data refresh

### 6.3 Insights & Benchmarking

753. **Performance comparison against the firm's own historical projects**
754. **Benchmarking against industry standards on selected KPIs**
755. KPI dashboards by discipline
756. Action recommendation from insight
757. Executive summary dashboard
758. Mobile access to insights

### 6.4 Procore AI (Helix / Datagrid layer)

759. **Procore Assist — conversational access to project specs, codes, and document libraries**
760. Natural language query over project data
761. **AI agents that update records autonomously**
762. **AI agent for document search across project corpus**
763. **AI agent for submittal review**
764. **AI agent for daily log drafting**
765. **AI agent for RFI evaluation**
766. **AI agent for contract risk identification**
767. Automatic response to project events (new RFI, submittal, change order)
768. **Agent Studio — user-configurable agent creation**
769. Automated document generation
770. Photo intelligence — jobsite progress summarisation from images
771. Safety insight surfacing from photographs
772. Predictive risk analytics benchmarked against historical data
773. AI-assisted asset location linking across 2D, 3D and map modes
774. Agent audit trail and transparency reporting
775. Model inventory disclosure and data-flow transparency

---

## SECTION 7 — OWNER & PORTFOLIO CAPABILITIES

776. Capital project portfolio view
777. Portfolio financial roll-up
778. Project stage gate tracking
779. Owner-side budget and funding source tracking
780. Contingency management at portfolio level
781. Owner invoice review and approval
782. Consultant contract management
783. Portfolio schedule roll-up
784. Cross-project reporting
785. Owner-side document control
786. Programme dashboard
787. Vendor performance across portfolio
788. Standardised workflow enforcement across projects
789. Portfolio risk visibility

---

## SECTION 8 — COMMERCIAL & OPERATIONAL MODEL

790. **Annual Construction Volume (ACV) based pricing** rather than per-seat
791. **Unlimited users on all subscriptions** — subs, owners and partners at no seat cost
792. Annual contract commitment
793. Modular product bundling
794. Implementation and onboarding services
795. Dedicated customer success management
796. **24/7 support included with unlimited access**
797. Procore Certification programme
798. Procore Academy / learning management
799. Procore Community peer forum
800. Groundbreak annual conference
801. Regional product localisation (US, Canada EN/FR, LATAM, UK, Germany, France, Spain, UAE, Australia/NZ, Singapore)
802. Multi-language interface for supported locales
803. Procore for Government edition
804. Procore.org social impact programme

---
---

# VOLUME II — THE GAP MAP

## What Procore Does Not Cover, and Why

**Classification key**
- **(S) Structural** — cannot be built without damaging their business model or contradicting their paying customer's interest. Permanently defensible.
- **(R) Roadmap** — absent today, coming. Do not build a company on these alone.
- **(G) Geographic/regulatory** — absent because their market is North America. Buildable by them, unattractive to them.

---

## DOMAIN A — PROCUREMENT INTEGRITY & ANTI-CORRUPTION ASSURANCE
### Classification: (S) — the strongest structural gap in the entire market

**The gap.** Procore holds every artefact needed to detect bid-rigging, collusive tendering, change-order abuse, phantom variations, and conflict-of-interest capture. It holds bid submission timestamps, bidder overlap across packages, price dispersion, change order frequency by vendor, and payment routing. It surfaces none of it as integrity signal.

**Why it is structural.** Procore's paying customer is the general contractor. Any feature that says *"your change orders look like fraud"* or *"these three bidders have submitted mathematically related prices"* is a product that accuses the buyer. A GC will not renew a subscription that generates evidence against it. This is not a roadmap omission — it is a conflict of interest that survives any amount of engineering investment. **The only party who will pay for this is the owner, the funder, the auditor, or the regulator — a buyer Procore does not serve and cannot serve without alienating the one it does.**

**Build list:**

1. Bid price dispersion analysis across a tender — coefficient of variation flagging
2. Detection of unusually low dispersion (complementary bidding signature)
3. Detection of consistent bid rotation patterns across multiple packages over time
4. Detection of identical or near-identical line-item unit rates across nominally independent bidders
5. Detection of proportional price relationships between bidders (constant-ratio bidding)
6. Metadata forensics on submitted bid documents — shared authorship, identical creation software, sequential document IDs
7. Submission timestamp clustering analysis
8. IP address and device fingerprint overlap across bidders
9. Shared bank account detection across nominally separate vendors
10. Shared director / beneficial owner detection via corporate registry integration
11. Shared address, phone, email domain detection across bidders
12. Cover-bidding detection — bidder who consistently loses to the same winner
13. Market share concentration monitoring by trade and geography
14. Winner rotation entropy scoring per procurement entity
15. Losing-bidder-becomes-subcontractor detection (a classic collusion tell)
16. Abnormally low tender detection with mandated justification workflow
17. Abnormally high tender detection against benchmark
18. Unbalanced bid detection — front-loading of early-programme items
19. Front-loading quantification on schedule of values
20. Unit rate outlier detection against regional benchmark distribution
21. Rate loading on likely-to-increase quantities detection
22. Post-award unit rate drift monitoring
23. Change order frequency scoring by vendor
24. Change order value as percentage of original contract with peer comparison
25. Time-to-first-change-order distribution analysis (early COs are a low-ball signal)
26. Repeat change-order-cause clustering per vendor
27. Scope creep versus genuine variation classification
28. Variation-without-instruction detection
29. Retrospective instruction detection (instruction dated after work performed)
30. Split-contract detection — packages sized just below procurement thresholds
31. Threshold-avoidance pattern detection across a portfolio
32. Direct award / single-source justification register with mandatory reasoning
33. Emergency procurement invocation frequency monitoring
34. Sole-source frequency by approving officer
35. Approving officer decision pattern analysis
36. Approver-vendor affinity scoring (which approver always approves which vendor)
37. Approval velocity anomaly detection (approvals faster than plausible review time)
38. Out-of-hours approval flagging
39. Segregation-of-duties violation detection
40. Same-person requisition-and-approval detection
41. Delegation-of-authority breach detection
42. Conflict of interest declaration register
43. Declaration-to-transaction cross-matching
44. Undeclared relationship detection via graph analysis
45. Politically exposed person (PEP) screening on vendors and beneficial owners
46. Sanctions list screening (OFAC, UN, EU, UK)
47. Debarment list screening (World Bank, ADB, AfDB, IADB, EBRD, national registers)
48. Adverse media screening on vendors and principals
49. Beneficial ownership chain resolution and visualisation
50. Shell company indicator scoring (recent incorporation, nominee directors, no web presence, no employees)
51. Vendor incorporation date versus first tender date analysis
52. Vendor with single client concentration detection
53. Ghost vendor detection — payments without deliverable evidence
54. Ghost worker detection — payroll entries without biometric or site access record
55. Duplicate payment detection
56. Duplicate invoice detection with fuzzy matching (amount, date, description)
57. Round-number invoice clustering (a manual-fabrication signature)
58. Benford's Law analysis on invoice and claim values
59. Just-below-threshold invoice clustering
60. Payment-to-non-contracted-party detection
61. Payment routing to high-risk jurisdictions flagging
62. Advance payment without bond detection
63. Retention release without certification detection
64. Certification without inspection evidence detection
65. Quantity certified versus quantity physically evidenced reconciliation
66. Over-certification detection against measured progress
67. Progress claim versus photographic/reality-capture evidence reconciliation
68. Material delivered versus material paid reconciliation
69. Material paid versus material installed reconciliation
70. Plant on site claimed versus telematics-verified reconciliation
71. Labour claimed versus site access control record reconciliation
72. Prequalification score manipulation detection
73. Prequalification criteria tailored-to-a-single-vendor detection
74. Specification tailoring detection — spec language matching one manufacturer's proprietary terms
75. Restrictive specification flagging
76. Tender period abnormally short flagging
77. Addendum issued too close to deadline flagging
78. Unequal information distribution detection (one bidder accessed documents earlier)
79. Bidder document access log asymmetry analysis
80. Clarification response asymmetry detection
81. Evaluation criteria weight change after tender opening detection
82. Evaluation score manipulation detection — score reversal analysis
83. Evaluator scoring outlier detection
84. Evaluator consistency scoring across tenders
85. Tender committee composition tracking and rotation compliance
86. Whistleblower intake channel with anonymity guarantee
87. Anonymous report triage and case management
88. Whistleblower protection audit trail
89. Grievance and complaint register with resolution SLA
90. Independent integrity reviewer read-only access role
91. Auditor workspace with immutable evidence packaging
92. Regulator portal with scoped, time-boxed access
93. Integrity risk score per project
94. Integrity risk score per vendor
95. Integrity risk score per procuring entity
96. Integrity risk score per approving officer
97. Red flag register with severity, status and disposition
98. Red flag escalation workflow to independent reviewer
99. False positive learning loop with reviewer feedback
100. Case file assembly for referral to enforcement
101. Chain-of-custody evidence handling
102. Cryptographic hashing of source documents at ingest
103. Tamper-evident audit log (append-only, hash-chained)
104. Retrospective back-dating detection on records
105. Record deletion attempt logging
106. Integrity dashboard for board and audit committee
107. OECD / UNCAC / World Bank procurement guideline mapping
108. FCPA and UK Bribery Act compliance reporting
109. Open Contracting Data Standard (OCDS) export
110. Public transparency portal publication with configurable redaction
111. Corruption typology library mapped to detectable signals
112. Scenario simulation — what a given fraud scheme would look like in the data
113. Peer entity benchmarking on integrity metrics
114. Longitudinal integrity trend reporting per entity

---

## DOMAIN B — QUANTITY SURVEYING & FORMAL MEASUREMENT
### Classification: (G) with (S) elements

**The gap.** Procore's Estimating is an American takeoff-and-assembly tool. It has no concept of a Bill of Quantities as a contractual measurement instrument, no standard method of measurement, no remeasurement discipline, and no final account process. Across the Commonwealth, the Gulf, much of Africa and Asia, the BQ *is* the contract's commercial spine. Procore treats it as an import format at best.

**Why it persists.** US practice is lump-sum and GMP-driven; the BQ tradition is genuinely foreign to their design assumptions. Retro-fitting measurement standards into a cost-code-centric data model is a rebuild, not a feature.

**Build list:**

115. Bill of Quantities as a first-class contractual object
116. BQ hierarchy — bill, section, work section, item, sub-item
117. Item coding compliant with NRM2 (New Rules of Measurement)
118. NRM1 order-of-cost estimating structure
119. NRM3 maintenance and operation cost structure
120. SMM7 measurement rules engine
121. CESMM4 / CESMM5 civil engineering measurement
122. POMI (Principles of Measurement International) support
123. ARM (Agreement of Rules of Measurement) support
124. ASMM / national method-of-measurement variants (Ghana, Nigeria, Kenya, India, Malaysia, Singapore, Hong Kong, Australia AS1181)
125. User-definable method of measurement rule sets
126. Measurement rule validation against selected standard
127. Preambles and preliminaries structure
128. Preliminaries as time-related versus fixed cost separation
129. Provisional sums — defined and undefined
130. Prime cost sums
131. Nominated subcontractor and supplier handling
132. Dayworks schedules with percentage additions
133. Contingency sum handling
134. Spot items
135. Taking-off sheets with dimension columns (timesing, dimension, squaring)
136. Traditional dimension paper format with waste calculations
137. Abstracting and billing process
138. Query sheet management
139. Taking-off audit trail from drawing to dimension to bill item
140. Quantity provenance — every quantity traceable to a measured source
141. Automated quantity extraction from 2D drawings with measurement-standard mapping
142. Automated quantity extraction from BIM with rule-based mapping to BQ items
143. IFC property-set to measurement-item mapping engine
144. Model-to-BQ reconciliation and variance reporting
145. Rate build-up sheets (labour, material, plant, overhead, profit per item)
146. All-in labour rate calculation with statutory on-costs
147. Plant rate build-up with ownership and operating cost
148. Material rate build-up with waste and delivery
149. Composite rate assembly
150. Rate library with regional and temporal versioning
151. Price book integration (Spon's, BCIS, regional equivalents)
152. Elemental cost planning by NRM1 element
153. Cost plan versioning across design stages (RIBA 0-7)
154. Cost plan reconciliation between stages
155. Cost checking against elemental benchmarks
156. Cost per functional unit (per m², per bed, per km, per MW)
157. Gross internal floor area and elemental quantity capture
158. Approximate quantities estimating
159. Cost limit and design-to-cost tracking
160. Value engineering register with option costing
161. Whole-life cost appraisal (NRM3)
162. Interim valuation preparation
163. Valuation based on remeasurement of work in place
164. Valuation based on percentage of BQ item
165. Valuation based on milestone/activity schedule
166. Materials on site valuation with vesting certificate handling
167. Materials off site valuation with bond requirement
168. Variation valuation using BQ rates
169. Variation valuation using pro-rata rates
170. Variation valuation using star rates (fair valuation)
171. Variation rate derivation audit trail
172. Remeasurement of provisional quantities against actual
173. Provisional sum expenditure and adjustment
174. Fluctuation calculation — formula method (NEDO / BCIS indices)
175. Fluctuation calculation — traditional method
176. Price adjustment formulae per FIDIC Sub-Clause 13.8
177. Index-linked escalation with published index ingestion
178. Currency adjustment on foreign-currency components
179. Interim payment certificate generation
180. Payment certificate versus payment application variance statement
181. Final account preparation
182. Final account statement with full adjustment schedule
183. Agreed final account sign-off workflow
184. Cost value reconciliation (CVR) — contractor side
185. CVR at package, project and portfolio level
186. Work in progress (WIP) and accrual calculation
187. Over/under-certification position statement
188. Cash flow forecast from BQ and programme (S-curve)
189. Earned value from measured quantities
190. Sub-contract package cost control against BQ allowances
191. Bill of quantities export to standard interchange formats
192. Comparative BQ analysis across projects for rate benchmarking

---

## DOMAIN C — INTERNATIONAL CONTRACT ADMINISTRATION
### Classification: (G)

**The gap.** Procore's contract logic encodes American practice: AIA documents, ConsensusDocs, the RFI/submittal/change order triad. It has no native understanding of FIDIC, NEC, JCT, PPC2000, AS4000 or the Gulf and Asian derivatives — which govern the overwhelming majority of internationally financed infrastructure.

**Build list:**

193. Contract form library with clause-level modelling
194. FIDIC Red Book (Construction) clause engine
195. FIDIC Yellow Book (Plant & Design-Build)
196. FIDIC Silver Book (EPC/Turnkey)
197. FIDIC Green Book (Short Form)
198. FIDIC Gold Book (DBO)
199. FIDIC Emerald Book (Underground Works)
200. FIDIC 1999 vs 2017 vs 2022 edition variance handling
201. Particular Conditions overlay on General Conditions
202. Clause amendment tracking against standard form
203. NEC3 and NEC4 Engineering and Construction Contract
204. NEC Option A/B/C/D/E/F variant logic
205. NEC Early Warning register and register meetings
206. NEC Compensation Event lifecycle with strict time bars
207. NEC quotation and assessment process with Defined Cost and Fee
208. NEC Schedule of Cost Components / Short SCC
209. NEC Accepted Programme submission and acceptance cycle
210. NEC programme rejection reason codes
211. NEC Activity Schedule and Bill of Quantities options
212. NEC Project Manager instruction register
213. NEC Supervisor and Defects Certificate handling
214. JCT Standard Building Contract suite
215. JCT Design and Build
216. JCT Intermediate / Minor Works
217. JCT Architect's Instruction register
218. JCT Relevant Event and Relevant Matter classification
219. PPC2000 / alliance and partnering contract structures
220. AS4000 / AS2124 (Australia)
221. Hong Kong Government General Conditions
222. Singapore PSSCOC / REDAS
223. Indian CPWD / NHAI contract forms
224. Gulf state public works contract forms
225. **Time bar engine — automatic notice deadline calculation from event date**
226. Notice requirement register per clause
227. Notice service method compliance (registered post, email, portal)
228. Notice proof-of-service capture
229. Time bar breach warning before expiry
230. Time bar breach recording where missed
231. Condition precedent compliance tracking
232. Engineer's / Project Manager's / Contract Administrator's determination register
233. Determination reasoning capture and publication
234. Engineer's instruction register with clause reference
235. Instruction cost and time impact declaration
236. Contractor's notice of dissatisfaction with determination
237. Extension of time (EOT) claim lifecycle
238. EOT entitlement mapped to specific contract clause
239. Concurrent delay analysis and apportionment position
240. Employer risk event versus contractor risk event classification
241. Force majeure / exceptional event invocation register
242. Change in law claim handling
243. Suspension and termination notice sequence
244. Taking-over certificate issuance
245. Sectional completion handling
246. Defects Notification Period tracking
247. Performance certificate issuance
248. Latent defects period tracking
249. Liquidated damages calculation and application
250. LD cap monitoring
251. Bonus / early completion incentive calculation
252. Performance security lifecycle (issue, reduction, release, call)
253. Advance payment guarantee and recovery schedule
254. Retention money guarantee substitution
255. Parent company guarantee register
256. Collateral warranty and third-party rights register
257. Assignment and novation tracking
258. Sub-contract back-to-back clause mapping to main contract
259. Flow-down obligation verification
260. Contract obligation register — every obligation with owner, deadline, evidence
261. Obligation compliance dashboard
262. Contractual correspondence with clause tagging
263. Without-prejudice and reserved-rights correspondence marking
264. Privileged communication segregation

---

## DOMAIN D — CLAIMS, DELAY & DISRUPTION
### Classification: (S) — Procore's customer does not want a system that documents its own delay culpability

**The gap.** Procore records that a delay happened. It has no forensic capability: no windows analysis, no as-planned versus as-built comparison, no measured mile, no quantum build-up, no SCL Protocol alignment. Every serious dispute exits the platform into spreadsheets and expert reports.

**Build list:**

265. Delay event register with cause classification
266. Delay event to contract clause mapping
267. Excusable / non-excusable / compensable classification
268. Culpable delay attribution with evidence
269. As-planned versus as-built comparison
270. Impacted as-planned analysis
271. Collapsed as-built (but-for) analysis
272. Time impact analysis (TIA) with fragnet insertion
273. Windows analysis with configurable window boundaries
274. Retrospective longest path analysis
275. Time slice analysis
276. **SCL Delay and Disruption Protocol (2nd ed.) methodology alignment**
277. AACE International RP 29R-03 forensic schedule analysis method selection
278. Concurrency identification and treatment options
279. Pacing delay identification
280. Float ownership rules configuration
281. Float consumption tracking by party
282. Critical path migration tracking over time
283. Programme quality assessment (DCMA 14-point check)
284. Out-of-sequence progress detection
285. Logic change detection between programme revisions
286. Constraint and lag manipulation detection
287. Activity duration change tracking across revisions
288. Baseline integrity verification
289. Disruption identification separate from delay
290. **Measured mile analysis with productive period selection**
291. Earned value based disruption quantification
292. Industry study application (MCAA, Leonard, Ibbs curves) with justification
293. Cumulative impact / ripple effect quantification
294. Trade stacking and overcrowding quantification
295. Out-of-sequence working cost quantification
296. Learning curve disruption analysis
297. Acceleration cost build-up
298. Constructive acceleration documentation
299. Prolongation cost calculation — time-related preliminaries
300. Site overhead allocation to prolongation period
301. Head office overhead recovery formulae (Hudson, Emden, Eichleay)
302. Loss of profit / loss of opportunity claim build-up
303. Finance charge and interest claim calculation
304. Claim preparation workspace with narrative structure
305. Cause-effect-entitlement-quantum chain enforcement
306. Evidence linking per claim assertion
307. Contemporaneous record sufficiency scoring
308. Record gap identification for claim exposure
309. Claim submission package assembly
310. Claim response and rebuttal management
311. Counterclaim register
312. Claim valuation range (best / likely / worst case)
313. Claim provision and accrual reporting
314. Claim success probability modelling from historical outcomes
315. Global claim identification and risk warning
316. Total cost claim identification and risk warning
317. Expert report supporting-schedule generation
318. Claim chronology auto-assembly from platform records
319. Scott Schedule generation
320. Claim register at portfolio level with exposure roll-up

---
## DOMAIN E — DISPUTE AVOIDANCE & RESOLUTION
### Classification: (S)

**The gap.** Procore ends where dispute begins. There is no adjudication support, no DAB/DAAB workflow, no arbitration bundle production, no settlement modelling. The moment a project turns contentious — precisely when the record matters most — the platform is abandoned.

321. Dispute Avoidance/Adjudication Board (DAAB) appointment register
322. DAAB member independence and disclosure tracking
323. Standing board site visit scheduling and report capture
324. Informal assistance request lifecycle
325. Referral to DAAB with submission timetable
326. DAAB decision register and compliance tracking
327. Notice of dissatisfaction with DAAB decision
328. Amicable settlement period tracking
329. Statutory adjudication (UK HGCRA, Singapore SOPA, Australia SOPA, Malaysia CIPAA, NZ CCA)
330. Adjudication notice and referral timetable engine
331. Adjudicator nomination request generation
332. Adjudication response and reply management
333. Adjudicator decision enforcement tracking
334. Mediation scheduling and position paper management
335. Expert determination referral
336. Arbitration commencement and tribunal constitution tracking
337. Institutional rules selection (ICC, LCIA, SIAC, HKIAC, DIAC, UNCITRAL)
338. Arbitration procedural timetable with deadline alerting
339. Pleadings register (statement of claim, defence, reply, rejoinder)
340. Redfern Schedule generation for document production
341. Document production request and objection management
342. Privilege review and redaction workflow
343. **Hearing bundle assembly with pagination and hyperlinked index**
344. Chronological bundle generation
345. Witness statement management with version control
346. Expert report management and joint statement tracking
347. Hot-tubbing preparation materials
348. Transcript management and issue tagging
349. Award and enforcement tracking
350. Settlement offer register (with and without prejudice)
351. Part 36 / Calderbank offer tracking and costs consequences
352. Settlement scenario modelling with expected value calculation
353. Litigation risk provisioning
354. Legal cost tracking against dispute
355. Recovery versus cost-of-recovery analysis
356. Dispute outcome database for organisational learning
357. Dispute root-cause analytics feeding back into contract drafting

---

## DOMAIN F — PAYMENT SECURITY & STATUTORY COMPLIANCE
### Classification: (G)

**The gap.** Procore Pay handles US lien waivers well. It does not implement the security-of-payment statutory regimes that govern most of the Commonwealth and Asia, where payment claims and payment schedules carry hard statutory deadlines and severe consequences for non-compliance.

358. Statutory payment claim generation compliant with jurisdiction rules
359. Payment schedule / payment response with statutory deadline engine
360. Deadline calculation from statutory reference date
361. Consequence-of-non-response warning (deemed liability)
362. Right-to-suspend notice generation and tracking
363. Progress payment entitlement calculation per statute
364. UK Housing Grants Construction and Regeneration Act compliance
365. UK payment notice and pay less notice engine
366. Singapore SOPA payment claim and response
367. Australian state-by-state SOPA variants (NSW, VIC, QLD, WA, SA)
368. Malaysia CIPAA compliance
369. New Zealand Construction Contracts Act
370. Ireland Construction Contracts Act
371. Canadian prompt payment and adjudication regimes (Ontario, Alberta, federal)
372. US state prompt payment statutes with variance handling
373. Mechanic's lien deadline engine by state
374. Preliminary notice generation and deadline tracking
375. Notice of intent to lien
376. Lien filing and release management
377. Stop notice handling
378. **Retention trust account compliance (project bank accounts, cascading trusts)**
379. Project bank account (PBA) integration and reconciliation
380. Cascading payment verification down the supply chain
381. Tier 2 and tier 3 subcontractor payment visibility
382. Payment-when-paid / pay-if-paid clause validity check by jurisdiction
383. Retention release statutory deadline tracking
384. Retention bond substitution management
385. Supply chain payment performance reporting (UK Prompt Payment Code, Duty to Report)
386. Days-to-pay analytics by tier
387. Late payment interest calculation per statute
388. Small business payment protection reporting
389. Insolvency early warning from payment behaviour
390. Supply chain financial health monitoring with credit data
391. Subcontractor insolvency contingency planning
392. Set-off and abatement justification register
393. Unlawful deduction detection

---

## DOMAIN G — OWNER-SIDE CAPITAL PROGRAMME GOVERNANCE
### Classification: (S) for public/DFI, (R) for private owners

**The gap.** Procore's owner tools are a thin layer over contractor tools. There is no business case lifecycle, no stage gate discipline, no benefits realisation, no appraisal methodology. Public clients and development finance institutions run on exactly these instruments.

394. Strategic outline case / outline business case / full business case lifecycle
395. HM Treasury Green Book five-case model (strategic, economic, commercial, financial, management)
396. Options appraisal with long list to short list narrowing
397. Do-nothing / do-minimum counterfactual modelling
398. Cost-benefit analysis with discounting
399. Net present value and benefit-cost ratio calculation
400. Economic internal rate of return
401. Social discount rate configuration by jurisdiction
402. **Optimism bias uplift application per HM Treasury / national guidance**
403. **Reference class forecasting against comparable project database**
404. Outside-view estimate generation versus inside-view estimate
405. Estimate uplift justification and challenge workflow
406. Sensitivity and switching value analysis
407. Distributional impact analysis
408. Stage gate definition and gate criteria
409. Gateway review scheduling (OGC/IPA Gateway 0-5 equivalent)
410. Gate review evidence pack assembly
411. Independent assurance reviewer workspace
412. Gate decision register with conditions
413. Conditions-of-approval tracking to closure
414. Delivery confidence assessment (RAG rating with narrative)
415. Assurance action tracking
416. Benefits register with owner and measurement method
417. Benefit baseline and target definition
418. Benefits realisation tracking post-completion
419. Benefits dependency network mapping
420. Disbenefit identification and tracking
421. Outcome versus output distinction and measurement
422. Logic model / theory of change capture
423. Programme business case aggregation from project cases
424. Portfolio prioritisation and scoring model
425. Multi-criteria decision analysis with weighting
426. Affordability envelope versus portfolio demand
427. Funding source allocation and tracking
428. Multi-year budget appropriation management
429. Fiscal year boundary handling and carry-forward
430. Capital versus revenue expenditure classification
431. Capitalisation policy application
432. Grant condition compliance tracking
433. Appropriation compliance and virement control
434. Whole-life cost commitment at approval
435. Post-implementation review scheduling and capture
436. Lessons learned register with mandatory closure
437. Project profile model / risk-tiering at initiation
438. Assurance intensity scaling by project tier
439. Programme-level dependency mapping between projects
440. Critical interdependency risk visualisation
441. Programme schedule integration across projects
442. Resource contention across the portfolio
443. Board and committee reporting pack automation
444. Ministerial / trustee briefing generation
445. Parliamentary / legislative reporting compliance
446. Public accountability disclosure packs

---

## DOMAIN H — RISK QUANTIFICATION & COST CERTAINTY
### Classification: (R) partially, (S) for independent challenge

**The gap.** Procore has a predictive risk feature. It has no quantitative risk analysis: no Monte Carlo, no P50/P80, no contingency drawdown discipline, no correlated risk modelling. Cost certainty in major projects is a probabilistic discipline and Procore is deterministic.

447. Qualitative risk register with probability and impact
448. Risk breakdown structure
449. Risk categorisation (technical, commercial, external, organisational, environmental, political)
450. Pre-mitigation and post-mitigation scoring
451. Risk appetite and tolerance threshold definition
452. Risk owner assignment and attestation
453. Mitigation action tracking with cost
454. Cost of mitigation versus expected value of risk
455. Risk-to-schedule-activity mapping
456. Risk-to-cost-line mapping
457. **Quantitative schedule risk analysis (QSRA) with Monte Carlo**
458. **Quantitative cost risk analysis (QCRA) with Monte Carlo**
459. Three-point estimating (optimistic, most likely, pessimistic)
460. Distribution selection per risk (triangular, PERT, uniform, lognormal, discrete)
461. Correlation matrix between risks
462. Common cause modelling
463. Risk event branching and probabilistic branching
464. Iteration count configuration and convergence testing
465. **P-value output (P50, P80, P90) for cost and completion date**
466. Tornado diagram of risk drivers
467. Criticality index per activity
468. Cruciality and sensitivity indices
469. Confidence-level based contingency setting
470. Contingency allocation to specific risks
471. **Contingency drawdown curve with planned versus actual**
472. Contingency release authority and approval workflow
473. Contingency exhaustion early warning
474. Management reserve separation from contingency
475. Risk-adjusted forecast cost at completion
476. Risk-adjusted forecast completion date
477. Escalation risk modelling separate from scope risk
478. Currency risk modelling and hedging position
479. Commodity price risk modelling with index linkage
480. Interest rate exposure modelling
481. Political risk scoring by jurisdiction
482. Force majeure probability modelling
483. Risk register versioning and trend
484. Risk velocity and proximity tracking
485. Emerging risk horizon scanning
486. Opportunity register (upside risk) with realisation tracking
487. Independent risk challenge workspace
488. Risk maturity assessment
489. Portfolio risk aggregation with diversification effect
490. Portfolio-level contingency optimisation

---

## DOMAIN I — ESG, CARBON, SOCIAL VALUE & WHOLE-LIFE
### Classification: (R) in North America, (G) internationally

**The gap.** Procore has effectively nothing here. Meanwhile carbon reporting is becoming a contractual condition in the UK, EU and increasingly the Gulf, and social value is a scored tender criterion in UK public procurement.

491. Embodied carbon calculation to EN 15978 / RICS Whole Life Carbon Assessment
492. Life cycle module accounting (A1-A5, B1-B7, C1-C4, D)
493. **PAS 2080 carbon management in infrastructure compliance**
494. Carbon baseline and reduction target setting
495. Carbon budget by element with drawdown tracking
496. Material carbon factor library (ICE database, EPD ingestion)
497. Environmental Product Declaration ingestion and verification
498. Product-specific versus generic carbon factor flagging
499. Design option carbon comparison
500. Carbon-cost trade-off analysis (marginal abatement cost)
501. Carbon hotspot identification by element
502. Transport carbon from supplier location and mode
503. Site energy and fuel consumption capture
504. Plant emissions by equipment hours and fuel type
505. Scope 1 emissions accounting
506. Scope 2 emissions accounting
507. **Scope 3 emissions accounting including purchased goods and services**
508. GHG Protocol reporting alignment
509. SBTi target tracking
510. Carbon offset register with verification
511. Operational carbon modelling and handover to asset management
512. Water consumption monitoring
513. Waste generation by stream
514. Waste diversion from landfill percentage
515. Circular economy material passport
516. Material reuse and recovery tracking
517. Biodiversity net gain calculation and monitoring
518. Habitat and ecology compliance tracking
519. Noise, dust and vibration monitoring integration
520. Air quality monitoring integration
521. Environmental incident register with regulator notification
522. Environmental permit and consent tracking
523. Environmental management plan compliance
524. ISO 14001 evidence assembly
525. BREEAM / LEED / Green Star / Estidama credit tracking
526. Credit evidence collection and assessor submission
527. **Social value measurement (UK TOMs framework)**
528. Social Value Model / PPN 06/20 theme scoring
529. Local employment commitment tracking
530. Apprenticeship and training week delivery
531. Local spend percentage tracking by radius
532. SME and VCSE spend tracking
533. **Local content compliance for resource-nationalist jurisdictions**
534. Indigenous participation commitment tracking
535. Diverse supplier spend reporting
536. Community investment tracking
537. Volunteering hours capture
538. Social value proxy financial valuation
539. Tender commitment versus delivered performance reconciliation
540. Social value shortfall remediation tracking
541. CSRD / ESRS disclosure data assembly
542. IFRS S1 / S2 sustainability disclosure data
543. EU Taxonomy alignment assessment
544. TCFD physical and transition risk reporting
545. Modern Slavery Act statement evidence
546. Supply chain ESG due diligence per CSDDD

---

## DOMAIN J — LAND, CONSENTS, RESETTLEMENT & COMMUNITY
### Classification: (S) — this is a category of work Procore has no concept of

**The gap.** Every internationally financed infrastructure project has a land acquisition, resettlement, permitting and community grievance dimension. It is frequently the single largest source of delay. Procore does not model it at all.

547. Land parcel register with cadastral reference
548. Land ownership and tenure record
549. Customary and communal tenure handling
550. Title verification and encumbrance check
551. Land acquisition negotiation tracking
552. Compulsory purchase / eminent domain process management
553. Valuation and compensation calculation
554. Compensation payment tracking with beneficiary verification
555. **Project Affected Person (PAP) census and register**
556. Household socio-economic baseline survey capture
557. Vulnerability screening of affected households
558. **Resettlement Action Plan (RAP) preparation and monitoring**
559. **IFC Performance Standard 5 compliance tracking**
560. World Bank ESS5 compliance tracking
561. Livelihood restoration programme tracking
562. Replacement housing delivery tracking
563. Resettlement site development monitoring
564. Cut-off date declaration and encroachment monitoring
565. Physical versus economic displacement classification
566. Entitlement matrix definition and application
567. Compensation-at-replacement-cost verification
568. Independent RAP monitoring and completion audit
569. **Community grievance redress mechanism (GRM)**
570. Grievance intake by multiple channels including anonymous
571. Grievance classification and severity triage
572. Grievance resolution SLA and escalation ladder
573. Grievance closure verification with complainant
574. Grievance analytics by type, location and time
575. Free, Prior and Informed Consent (FPIC) process documentation
576. Indigenous peoples plan compliance (IFC PS7 / ESS7)
577. Cultural heritage chance-find procedure
578. Archaeological discovery register and stop-work protocol
579. Stakeholder register with influence/interest mapping
580. Stakeholder engagement plan and activity log
581. Public consultation event management and attendance
582. Consultation feedback capture and disposition
583. Community liaison officer activity tracking
584. Public information disclosure register
585. Permit and consent register with authority and status
586. Planning permission condition discharge tracking
587. Environmental impact assessment condition tracking
588. Statutory undertaker / utility diversion coordination
589. Wayleave and easement management
590. Road closure and traffic management permit tracking
591. Consent-to-programme dependency mapping and delay risk
592. Regulator correspondence register

---
## DOMAIN K — MULTI-CURRENCY, MULTI-JURISDICTION & EMERGING MARKET OPERATION
### Classification: (G)

**The gap.** Procore is a single-currency, single-tax-regime system with locale skins on top. Internationally financed projects run three or four currencies simultaneously with contractual exchange mechanics.

593. Multi-currency contract with defined currency proportions
594. Foreign and local currency portion split per FIDIC Sub-Clause 14.15
595. Contractual exchange rate fixing at base date
596. Payment in multiple currencies against one certificate
597. Exchange rate source configuration and audit
598. Rate-of-exchange dispute handling
599. Realised versus unrealised FX gain/loss reporting
600. Hedging instrument register and effectiveness
601. Currency control and repatriation restriction tracking
602. Multi-entity consolidation with FX translation
603. Functional versus presentation currency handling
604. Inflation-adjusted reporting for high-inflation economies
605. Hyperinflationary accounting (IAS 29) support
606. Country-specific chart of accounts mapping
607. Multi-jurisdiction statutory reporting
608. Import duty and customs clearance tracking
609. Customs bond and temporary import tracking
610. Port clearance delay logging with claim linkage
611. Border and logistics delay attribution
612. Local content certification and verification
613. In-country value (ICV) scoring for Gulf jurisdictions
614. Expatriate work permit and visa tracking
615. Local employment quota compliance
616. Offline-first architecture for genuinely low-connectivity sites
617. SMS and USSD data capture channel
618. Feature-phone and low-spec Android support
619. Low-bandwidth synchronisation with delta compression
620. Intermittent-power operational tolerance
621. Paper-to-digital capture via photograph with OCR fallback
622. Multi-language including non-Latin script and RTL
623. Regional date, number and measurement unit conventions
624. Metric and imperial dual display
625. Local holiday calendar and working-day calculation
626. Regional data residency for sovereignty requirements

---

## DOMAIN L — ASSET HANDOVER, DIGITAL TWIN & WHOLE-LIFE OPERATION
### Classification: (R)

**The gap.** Procore closes at closeout. The asset then lives 30-60 years with no data continuity. Owners pay for construction data and receive PDFs.

627. Asset register creation during construction
628. Asset hierarchy aligned to Uniclass / Omniclass / SFG20
629. Asset tagging with unique persistent identifier
630. **COBie deliverable generation and validation**
631. IFC model handover with property set verification
632. **ISO 19650 information delivery milestone management**
633. Exchange Information Requirements (EIR) definition
634. BIM Execution Plan compliance verification
635. Information Delivery Plan (MIDP/TIDP) tracking
636. Level of Information Need verification per milestone
637. **Information Delivery Specification (IDS) automated validation**
638. Model quality gate before acceptance
639. Common Data Environment state management (WIP/Shared/Published/Archived)
640. Suitability code enforcement per ISO 19650
641. O&M manual assembly and indexing
642. Warranty register with start date and duration per asset
643. Warranty claim lodgement and tracking
644. Warranty expiry alerting to owner
645. Defect liability period management post-handover
646. Spare parts register and initial stock
647. Maintenance strategy definition per asset class
648. Preventive maintenance schedule seeding from handover data
649. Statutory inspection requirement seeding
650. Training and competency handover record
651. As-built drawing verification against reality capture
652. **Golden thread of building safety information (UK Building Safety Act)**
653. Building safety case file assembly
654. Duty holder and accountable person register
655. Higher-risk building gateway compliance
656. Product traceability and construction product regulation compliance
657. Material and product certification chain of custody
658. Digital twin instantiation from construction data
659. Sensor and IoT data association to asset
660. Operational performance versus design intent monitoring
661. Energy performance gap tracking
662. Whole-life cost actual versus forecast
663. Renewal and replacement forecasting
664. Condition assessment and degradation modelling
665. Decommissioning and end-of-life planning
666. Material recovery and demolition audit data

---

## DOMAIN M — WORKFORCE RIGHTS, WELFARE & LABOUR COMPLIANCE
### Classification: (S) internationally, (G) partially

**The gap.** Procore tracks labour as cost and hours. It does not track labour as people with rights — which is a hard contractual condition on every DFI-financed project and increasingly on private developments in the Gulf.

667. Individual worker register with verified identity
668. Biometric enrolment and site access control integration
669. **Ghost worker elimination via biometric-to-payroll reconciliation**
670. Worker age verification and child labour prevention
671. Recruitment fee charging detection (forced labour indicator)
672. **Passport retention detection and prohibition monitoring**
673. Recruitment agency register and audit
674. Employment contract issuance verification in worker's language
675. Contract substitution detection
676. **Wage Protection System integration for Gulf jurisdictions**
677. Wage payment verification against hours worked
678. Minimum wage compliance by jurisdiction
679. Overtime limit compliance monitoring
680. Rest day and maximum consecutive days monitoring
681. Wage deduction legality checking
682. Late or non-payment of wages escalation
683. Accommodation standard inspection and scoring
684. Occupancy density compliance
685. Sanitation and welfare facility compliance
686. Heat stress protocol and work-rest cycle enforcement
687. Potable water provision verification
688. Transport safety compliance
689. **Worker grievance mechanism independent of employer**
690. Anonymous worker voice channel with multilingual support
691. Grievance retaliation monitoring
692. Freedom of association compliance recording
693. Migrant worker vulnerability screening
694. **Modern slavery indicator scoring at subcontractor level**
695. ILO core convention compliance mapping
696. IFC PS2 labour and working conditions compliance
697. Subcontractor labour audit programme
698. Unannounced audit scheduling and finding tracking
699. Corrective action plan tracking with verification
700. Worker welfare KPI reporting to lender
701. Fatality and serious injury independent reporting channel
702. Incident under-reporting detection (statistical anomaly)
703. Worker demographic and turnover analytics
704. Skills development and certification pathway tracking

---

## DOMAIN N — DATA SOVEREIGNTY, INTEROPERABILITY & EXIT
### Classification: (S) — Procore's lock-in is a business asset, not a bug

**The gap.** The platform is a data roach motel by design. Its economics depend on switching costs. An owner-first platform can make openness a competitive weapon precisely because the incumbent cannot copy it without destroying its own retention.

705. Full-fidelity data export including relationships, not just tables
706. Continuous data mirroring to customer-controlled storage
707. Customer-owned data lake with live replication
708. **Contractual data portability guarantee with tested exit runbook**
709. Open schema publication
710. Open Contracting Data Standard native output
711. ISO 19650 native compliance rather than mapping
712. buildingSMART IFC 4.3 native support
713. bSDD (buildingSMART Data Dictionary) alignment
714. IDS validation as a first-class function
715. BCF (BIM Collaboration Format) issue exchange
716. Uniclass 2015 / Omniclass / MasterFormat / CoClass classification switching
717. CSI / CI/SfB / NRM code cross-walking
718. Bring-your-own-cloud deployment option
719. On-premise deployment for sovereign clients
720. Air-gapped deployment for defence and critical infrastructure
721. Customer-managed encryption keys
722. Data residency selection at project level
723. Cross-border data transfer control
724. Vendor-neutral integration layer (no marketplace tax)
725. Open API with no rate-limit commercial gatekeeping
726. Open webhook and event stream
727. Third-party audit access without vendor mediation
728. Source-available or escrowed code for critical deployments

---

## DOMAIN O — PROJECT FINANCE, DRAWDOWN & DEVELOPMENT FINANCE
### Classification: (S)

**The gap.** Procore models cost. It does not model money — where it comes from, on what conditions, and what happens when conditions are breached. Every DFI-financed project runs on disbursement conditionality that no construction platform touches.

729. Funding facility register with lender and instrument type
730. Loan agreement condition precedent tracking
731. Conditions subsequent tracking
732. Disbursement request preparation and evidence assembly
733. **Lender disbursement conditionality verification before request**
734. Withdrawal application generation (World Bank / ADB / AfDB formats)
735. Statement of expenditure preparation
736. Designated account and special account reconciliation
737. Eligible versus ineligible expenditure classification
738. Ineligible expenditure recovery tracking
739. Category and allocation limit monitoring
740. Disbursement forecast versus actual
741. Undisbursed balance and closing date monitoring
742. Loan covenant compliance monitoring
743. Financial covenant ratio calculation and headroom
744. Lender's technical advisor (LTA) workspace and certification
745. Independent engineer certification workflow
746. Milestone-based disbursement trigger verification
747. Drawdown schedule versus construction programme alignment
748. Cash flow waterfall modelling
749. Debt service reserve monitoring
750. Interest during construction calculation and capitalisation
751. Commitment fee calculation
752. PPP / concession financial model integration
753. Availability payment calculation
754. Performance deduction mechanism and abatement calculation
755. Unitary charge computation
756. Refinancing gain share calculation
757. Equity injection schedule and verification
758. Sponsor support obligation tracking
759. Grant and blended finance tranche management
760. Counterpart funding obligation tracking
761. Procurement method compliance with lender rules (ICB, NCB, shopping, direct)
762. Prior review versus post review threshold application
763. **No-objection request and issuance tracking**
764. Lender procurement audit finding tracking
765. Misprocurement declaration risk monitoring
766. Fiduciary risk assessment and rating
767. Financial management action plan tracking
768. External audit finding and management response tracking
769. Interim unaudited financial report generation
770. Project financial statement preparation

---

## DOMAIN P — INSURANCE & BONDING LIFECYCLE
### Classification: (R)

771. Insurance programme structure register (CAR/EAR, TPL, professional indemnity, employer's liability, marine cargo, delay in start-up)
772. Policy document repository with schedule extraction
773. Coverage limit and sub-limit tracking
774. Deductible and excess tracking
775. Named insured and additional insured verification
776. Waiver of subrogation verification
777. Policy period versus contract period gap detection
778. Coverage gap analysis across the supply chain
779. Owner-controlled versus contractor-controlled programme handling
780. Certificate of insurance collection and expiry automation
781. Certificate authenticity verification against insurer
782. Premium allocation to project cost
783. Insurance claim notification deadline engine
784. Claim lodgement and documentation assembly
785. Loss adjuster coordination
786. Claim reserve and recovery tracking
787. Uninsured loss identification
788. Deductible exhaustion tracking
789. Claims history affecting future premium
790. Bond register (bid, performance, advance payment, retention, maintenance, payment)
791. Bond issuance verification with surety
792. Bond expiry and extension management
793. Bond reduction on milestone achievement
794. Bond call procedure and evidence assembly
795. Surety capacity utilisation tracking
796. Bonding line headroom monitoring
797. Parent company guarantee versus bond substitution analysis

---

## DOMAIN Q — TAX & STATUTORY DEDUCTION
### Classification: (G)

798. VAT / GST treatment by jurisdiction and supply type
799. Reverse charge mechanism for construction services
800. **UK CIS (Construction Industry Scheme) deduction and verification**
801. Subcontractor verification with tax authority
802. Deduction rate determination and application
803. CIS monthly return preparation
804. Withholding tax calculation on cross-border payments
805. Double taxation treaty relief application
806. Permanent establishment risk monitoring by day count
807. Expatriate personal tax day-count tracking
808. Payroll tax and social contribution by jurisdiction
809. Certified payroll (Davis-Bacon) full compliance
810. Prevailing wage determination application
811. Apprenticeship ratio compliance
812. Transfer pricing documentation for inter-company charges
813. Cost-plus inter-company margin substantiation
814. Customs duty and import tax cost allocation
815. Stamp duty on contracts
816. Local levy and cess calculation (India, Nigeria, others)
817. Industry training levy (CITB and equivalents)
818. Tax invoice compliance by jurisdiction
819. E-invoicing mandate compliance (Gulf, EU, LATAM)
820. Tax audit evidence assembly

---

## DOMAIN R — INDEPENDENT BENCHMARKING & PERFORMANCE INTELLIGENCE
### Classification: (S) — the benchmark must be independent of the benchmarked

**The gap.** Procore Insights benchmarks a firm against "industry standards" derived from Procore's own customer base — a self-selected, contractor-weighted, North America-skewed sample, curated by a vendor whose commercial interest is customer retention rather than uncomfortable truth. There is no independent, methodologically transparent, owner-side benchmark of what things should cost and how long they should take.

821. Independent cost benchmark database by asset class
822. Cost per functional unit normalised (per m², per bed, per km, per MW, per classroom place)
823. Location factor adjustment
824. Time factor / index adjustment to common base date
825. Currency normalisation with PPP option
826. Scope normalisation to a defined boundary
827. Specification level adjustment
828. Site condition and complexity adjustment
829. Procurement route adjustment
830. **Transparent, published normalisation methodology**
831. Benchmark sample size and confidence disclosure
832. Outlier treatment disclosure
833. Reference class definition and membership criteria
834. Reference class forecast generation for new projects
835. Cost overrun distribution by asset class
836. Schedule overrun distribution by asset class
837. Benefit shortfall distribution by asset class
838. Probability of exceeding budget by X%
839. Peer entity performance comparison
840. Contractor performance benchmarking across clients
841. Consultant performance benchmarking
842. Unit rate benchmark distribution by trade and region
843. Rate outlier detection against benchmark at tender evaluation
844. Preliminaries percentage benchmark
845. Design fee percentage benchmark
846. Change order percentage benchmark by procurement route
847. Claim incidence benchmark by contract form
848. Dispute incidence benchmark
849. Programme duration benchmark by asset class and size
850. Productivity benchmark by trade
851. Safety performance benchmark
852. Carbon intensity benchmark by asset class
853. Benchmark contribution mechanism with anonymisation
854. Differential privacy on contributed data
855. Contribution incentive model (contribute to access)
856. Benchmark versioning and reproducibility
857. Academic and audit access tier
858. Public interest publication of aggregate findings

---

## DOMAIN S — EVIDENTIARY INTEGRITY & FORENSIC AUDIT
### Classification: (S)

**The gap.** Procore's audit log is an operational convenience, not an evidentiary instrument. In a dispute or a corruption investigation, the question is whether the record can be trusted — and a mutable log administered by one party to the dispute cannot be.

859. Append-only, hash-chained event log
860. Cryptographic notarisation of record state at defined events
861. Optional distributed ledger anchoring for high-value certifications
862. Document hash at ingest with verification on retrieval
863. Tamper detection and alerting
864. Immutable timestamping from trusted time source
865. Backdating detection on all records
866. Post-hoc edit detection with original content preservation
867. Deletion attempt logging with content retention
868. Administrative override logging with justification requirement
869. Privileged action alerting to independent party
870. Superuser action review workflow
871. Log export in forensically admissible format
872. Chain of custody documentation for exported evidence
873. Third-party attestation of log integrity
874. Independent escrow of log hashes
875. Metadata preservation on all uploaded documents
876. Document provenance chain (who created, edited, approved)
877. Photograph authenticity verification (EXIF integrity, manipulation detection)
878. AI-generated content detection and labelling
879. Signature authenticity and non-repudiation
880. Qualified electronic signature support (eIDAS)
881. Witness and attestation capture
882. Evidence pack assembly with completeness certification
883. Redaction with irreversibility and audit
884. Disclosure log for litigation
885. Retention schedule enforcement with legal hold override

---

## DOMAIN T — DESIGN MANAGEMENT & UPSTREAM CHANGE CONTROL
### Classification: (R)

886. Design programme integrated with construction programme
887. Design deliverable register with responsibility matrix
888. Design responsibility matrix (RIBA / AIA / ISO 19650)
889. Design stage gate with sign-off
890. Design freeze declaration and change control thereafter
891. Design change request lifecycle with cost and time impact
892. Design change authorisation levels
893. Design change cost attribution to originator
894. Design development versus design change distinction
895. Client-driven versus designer-driven change classification
896. Design change frequency analytics by discipline
897. Rework cost attribution to design cause
898. Requirement traceability from brief to design to construction to handover
899. Brief and Employer's Requirements register
900. Requirement verification and validation matrix
901. Derogation and deviation register with approval
902. Value engineering proposal register with acceptance tracking
903. Buildability and constructability review capture
904. Design risk assessment (CDM designer duties)
905. Designer risk register and residual risk register
906. Pre-construction information assembly
907. Health and safety file assembly
908. Design coordination clash resolution with cost consequence
909. Consultant appointment and scope register
910. Consultant deliverable versus fee drawdown
911. Consultant performance scoring
912. Professional indemnity adequacy against design liability

---

## DOMAIN U — SUPPLY CHAIN, LOGISTICS & OFFSITE MANUFACTURE
### Classification: (R)

913. Multi-tier supply chain mapping and visibility
914. Tier 2 and tier 3 supplier identification
915. Critical component single-source identification
916. Supply chain risk scoring and concentration analysis
917. Supplier financial health monitoring
918. Long lead item register with order-by-date engine
919. Order-by-date to programme linkage with alerting
920. Procurement schedule integrated with construction programme
921. Purchase requisition to order to delivery to installation chain
922. Manufacturing progress monitoring at supplier premises
923. Factory acceptance test scheduling and results
924. Offsite manufacture progress verification for payment
925. Vesting certificate and title transfer on offsite materials
926. Offsite storage insurance and inspection verification
927. **DfMA module tracking from design to factory to site to installation**
928. Module unique identifier and lifecycle tracking
929. Kitting and pre-assembly management
930. Just-in-time delivery sequencing
931. Delivery slot booking and site logistics management
932. Vehicle booking system with gate integration
933. Site logistics plan with crane and hoist allocation
934. Laydown area allocation and conflict management
935. Material handling and double-handling minimisation
936. Consolidation centre operations
937. Shipment tracking with GPS and milestone events
938. Customs and port clearance milestone tracking
939. Damage and shortage on delivery register
940. Supplier claim and credit note management
941. Inventory management on site with reconciliation
942. Material wastage measurement against allowance
943. Theft and shrinkage detection
944. Return and surplus material management
945. Supply chain carbon and provenance traceability
946. Conflict mineral and responsible sourcing verification
947. Product certification and CE/UKCA marking verification

---

## DOMAIN V — COMMISSIONING, SYSTEMS TURNOVER & PERFORMANCE VERIFICATION
### Classification: (R)

948. Systems and subsystems breakdown structure
949. Commissioning plan with system boundaries
950. Turnover package definition by system
951. Construction completion certification per system
952. Pre-commissioning checklist per equipment tag
953. Equipment tag register with full lifecycle status
954. Loop check and point-to-point verification
955. Instrument calibration record
956. Static and dynamic commissioning phase tracking
957. Functional performance testing with acceptance criteria
958. Integrated systems testing
959. Performance test protocol and results capture
960. Guarantee performance verification against contract
961. Liquidated damages for performance shortfall calculation
962. Reliability run tracking
963. Punch list segregation by criticality (A/B/C) for handover
964. Certificate of practical/substantial completion per system
965. Ready-for-start-up certification
966. Mechanical completion certification
967. Energisation and permit-to-operate management
968. Regulatory approval for operation tracking
969. Fire and life safety system certification
970. Statutory inspection sign-off (lifts, pressure, electrical)
971. Operator training delivery and competence verification
972. Handover certificate and asset transfer record
973. Seasonal commissioning scheduling post-handover
974. Post-occupancy evaluation
975. Soft landings framework compliance

---

## DOMAIN W — ORGANISATIONAL LEARNING & KNOWLEDGE CAPTURE
### Classification: (S)

**The gap.** Every project generates knowledge that dies with the project team. Procore stores records; it does not create institutional memory. This matters more for owners with repeat programmes than for contractors, which is why Procore has little incentive.

976. Lessons learned capture with mandatory triggers
977. Lesson classification and searchability
978. Lesson to future-project applicability matching
979. Lesson closure — evidence that a lesson changed a practice
980. Standard detail and solution library from proven projects
981. Risk realisation feedback into standard risk register templates
982. Estimate accuracy feedback loop (estimated versus actual by element)
983. Rate library auto-update from actual costs
984. Duration library auto-update from actual programme performance
985. Assumption register with post-hoc validation
986. Decision log with rationale and outcome review
987. Contract clause performance analytics (which clauses generate disputes)
988. Procurement route outcome analytics
989. Supplier performance database persisting across projects and entities
990. Individual and team performance patterns (with appropriate governance)
991. Post-project review with structured protocol
992. Knowledge graph across projects, people, problems and solutions
993. Institutional memory search across decades of projects
994. Onboarding pack generation from prior similar projects

---

## DOMAIN X — AI ARCHITECTURE
### Classification: (S) in part

**The gap.** Procore's AI is retrieval and automation over a relational record that humans still populate. The record is the input. A genuinely AI-native system inverts this: reality is captured continuously and the record is *derived*, with humans reviewing exceptions. Procore cannot invert this without abandoning the manual-entry workflows their entire customer base is trained on and their entire permission model assumes.

995. Continuous reality capture as primary data source
996. Automatic progress determination from imagery against model
997. Automatic quantity installed determination from reality capture
998. Automatic valuation proposal from verified physical progress
999. Discrepancy detection between claimed and observed progress
1000. Automatic daily log generation from site sensor and image data
1001. Automatic manpower count from access control and imagery
1002. Automatic equipment utilisation from telematics without manual logging
1003. Automatic delay event detection from progress deviation
1004. Automatic causation hypothesis generation with evidence
1005. Contract clause retrieval triggered by detected event
1006. Automatic notice drafting when a time bar is triggered
1007. Proactive time bar alerting before the deadline, not after
1008. Obligation monitoring agent across the full contract corpus
1009. Automatic identification of unperformed contractual obligations
1010. Risk agent monitoring leading indicators continuously
1011. Integrity agent monitoring transaction patterns continuously
1012. Anomaly explanation in natural language with evidence links
1013. Counterfactual analysis ("if this had not occurred...")
1014. Multi-document reasoning across contract, programme, correspondence and cost
1015. Claim narrative drafting from contemporaneous records
1016. Rebuttal identification against an opposing claim
1017. Evidence sufficiency scoring for any assertion
1018. Confidence and uncertainty quantification on every AI output
1019. **Full citation of source records for every AI assertion**
1020. Human-in-the-loop review queue for consequential outputs
1021. Model output audit trail with input provenance
1022. Agent action authorisation limits
1023. Agent action reversal and rollback
1024. Adversarial testing of integrity detection models
1025. Model bias assessment on vendor and worker-affecting decisions
1026. Explainability requirement for any adverse determination
1027. Independent model validation for regulated use

---

## DOMAIN Y — COMMERCIAL MODEL & MARKET ACCESS
### Classification: (S) — this is a business model gap, not a feature gap

**The gap.** ACV-based pricing with five-figure annual minimums and annual commitments structurally excludes the majority of the world's construction firms. This is not an oversight; it is a deliberate up-market strategy that leaves an enormous underserved base.

1028. Per-project pricing with no annual commitment
1029. Usage-based pricing tiers
1030. Free tier for single small projects
1031. Published, transparent pricing with no sales negotiation required
1032. Local currency pricing with purchasing power adjustment
1033. Mobile money and local payment rail support
1034. Prepaid and pay-as-you-go models
1035. Cooperative / association licensing for SME groups
1036. Donor or government-subsidised licensing for public entities
1037. Self-service onboarding measured in hours not months
1038. Template-driven configuration replacing consultant implementation
1039. In-product guided setup replacing training programmes
1040. Progressive disclosure — small teams see a small product
1041. Role-based simplified interfaces for low-digital-literacy users
1042. Zero-training field capture flows
1043. Subcontractor-first design rather than subcontractor-tolerated
1044. Free permanent access for supply chain participants
1045. Migration tooling from spreadsheets
1046. Migration tooling from Procore, Autodesk and Aconex
1047. Parallel-run mode during transition

---

## DOMAIN Z — MISCELLANEOUS CRITICAL ABSENCES

1048. Bid/no-bid decision support with win probability modelling
1049. Historical win rate analytics by client, type and competitor
1050. Competitor pricing intelligence from historical tender outcomes
1051. Tender resource cost tracking and cost-of-sale analysis
1052. Opportunity pipeline and capacity planning integration
1053. Framework and call-off contract management
1054. Mini-competition management within frameworks
1055. Term contract and schedule of rates management
1056. Measured term contract order management
1057. Joint venture and consortium accounting with partner shares
1058. JV governance, board and deed compliance tracking
1059. Partner contribution and distribution tracking
1060. Special purpose vehicle financial reporting
1061. Multi-party alliance pain/gain share calculation
1062. Target cost contract gain share computation
1063. Open book cost verification and audit
1064. Cost reimbursable audit rights execution
1065. Defined cost verification against Schedule of Cost Components
1066. Disallowed cost register
1067. Site security and access control integration
1068. Visitor and induction management at scale
1069. Emergency muster and headcount reconciliation
1070. Lone worker monitoring
1071. Confined space entry live tracking
1072. Exclusion zone and proximity warning integration
1073. Wearable safety device integration
1074. Drone flight planning, permit and data pipeline
1075. Laser scanning pipeline and registration
1076. Point cloud to model comparison and deviation reporting
1077. Survey control and setting-out record management
1078. Geotechnical investigation data management
1079. Ground condition change detection against baseline
1080. Utility strike prevention record and permit
1081. Weather data historical archive for claim substantiation
1082. Weather baseline versus actual for exceptional weather claims
1083. Tidal, river and marine condition tracking
1084. Seismic and environmental event logging
1085. Concrete pour record with batch traceability
1086. Concrete test result management with statistical analysis
1087. Welding procedure and welder qualification register
1088. Weld map and NDT result tracking
1089. Material test certificate register with traceability to heat number
1090. Non-conformance report (NCR) lifecycle with disposition
1091. Concession and waiver register
1092. Quality hold point and witness point management
1093. Inspection and Test Plan (ITP) management
1094. ITP sign-off chain with third-party surveillance
1095. Quality audit programme and finding tracking
1096. ISO 9001 evidence assembly
1097. Calibration register for site test equipment
1098. Rework register with cost and cause attribution
1099. Cost of quality measurement (prevention, appraisal, failure)
1100. First-time-right measurement by trade

---
# VOLUME III — BUILD ARCHITECTURE & SEQUENCE

---

## 1. THE STRATEGIC READ

Volume I contains roughly 800 enumerated functions. Volume II contains roughly 1,100 more. Nobody builds 1,900 functions. The question is which subset constitutes a coherent, sellable, defensible product.

Three observations from the inventory:

**First — the parity trap.** Sections 2 and 3 of Volume I (Project Execution and Financials) are where every challenger dies. They are unglamorous, enormous, and worth nothing competitively because Procore already does them adequately. Building them first means eighteen months of work that generates no differentiation and no reference customer.

**Second — the gap concentration.** Of the 26 gap domains, seven are marked structural and share a single characteristic: **they all serve the owner, the funder, the auditor or the regulator rather than the contractor.** Domains A (integrity), D (claims), E (disputes), G (capital governance), N (data sovereignty), O (project finance), R (independent benchmarking) and S (evidentiary integrity) are one product, not eight. They are the assurance layer over capital delivery.

**Third — the wedge is verification, not management.** Procore's core assertion is *"here is what our users entered."* The gap is *"here is what actually happened, and here is where the two diverge."* Every structural gap reduces to that one sentence. Reconciliation between claimed and observed is the product.

---

## 2. THE PRODUCT DEFINITION

**Working name:** the assurance layer for capital delivery.

**Primary buyer:** public infrastructure clients, development finance institutions, sovereign wealth and state investment funds, owner's representatives, project management consultants, audit institutions, anti-corruption agencies.

**Core assertion:** every certified payment, every approved variation, every awarded contract and every claimed day of delay is reconciled against independent evidence, and every divergence is surfaced, scored and escalated.

**Why the incumbent cannot follow:** the product's output is adverse to the party that pays Procore's invoice.

---

## 3. MODULE MAP

### Tier 1 — Core (build first, months 0-9)

| Module | Drawn from | Function count |
|---|---|---|
| M1. Evidence Ledger | Domain S | ~27 |
| M2. Integrity Signal Engine | Domain A | ~114 |
| M3. Reconciliation Engine | Domains A, X | ~35 |
| M4. Entity & Beneficial Ownership Graph | Domain A | ~20 |
| M5. Assurance Workspace (auditor/reviewer/regulator roles) | Domains A, S, G | ~25 |
| M6. Ingestion Layer (Procore, Autodesk, Aconex, ERP, spreadsheets) | Domain N | ~30 |

### Tier 2 — Commercial depth (months 9-20)

| Module | Drawn from | Function count |
|---|---|---|
| M7. Measurement & Valuation Engine (BQ, SMM, remeasurement, certification) | Domain B | ~78 |
| M8. Contract Intelligence (FIDIC/NEC/JCT clause engine, time bars, obligations) | Domain C | ~72 |
| M9. Delay & Disruption Forensics | Domain D | ~56 |
| M10. Payment Security & Statutory Compliance | Domain F | ~36 |
| M11. Independent Benchmark Service | Domain R | ~38 |

### Tier 3 — Programme & capital governance (months 18-30)

| Module | Drawn from | Function count |
|---|---|---|
| M12. Business Case & Stage Gate | Domain G | ~53 |
| M13. Quantitative Risk (Monte Carlo, P-values, contingency drawdown) | Domain H | ~44 |
| M14. Disbursement & Lender Conditionality | Domain O | ~42 |
| M15. Dispute Support & Bundle Production | Domain E | ~37 |

### Tier 4 — Safeguards & sustainability (months 24-40)

| Module | Drawn from | Function count |
|---|---|---|
| M16. Land, Resettlement & Grievance | Domain J | ~46 |
| M17. Worker Welfare & Labour Rights | Domain M | ~38 |
| M18. Carbon, ESG & Social Value | Domain I | ~56 |
| M19. Multi-jurisdiction & Emerging Market Operations | Domain K | ~34 |

### Tier 5 — Parity (only if displacing, not augmenting)

Everything in Volume I Sections 1-5. Approximately 650 functions. Do not start here. Reach for it only when a customer refuses to run two systems, and even then consider acquiring rather than building.

---

## 4. DATA MODEL PRIMITIVES

The whole architecture rests on eight objects. Get these right and everything else is CRUD.

**1. `Assertion`** — any claim made by any party. A quantity, a rate, a completion percentage, an entitlement, a headcount. Attributes: claimant, value, unit, basis, timestamp, contract reference.

**2. `Evidence`** — anything that bears on whether an assertion is true. A photograph, a telematics record, a biometric log, a delivery note, a survey, an inspection, a bank transaction. Attributes: source, capture timestamp, hash, provenance chain, independence score.

**3. `Reconciliation`** — the join between assertion and evidence. Attributes: method, result, variance, confidence, reviewer, disposition. **This is the product. Everything else is scaffolding around this table.**

**4. `Obligation`** — a contractual duty. Attributes: source clause, obligor, obligee, trigger, deadline, evidence requirement, status. Time bars are `Obligation` records with a computed deadline.

**5. `Event`** — something that occurred. Attributes: type, timestamp, location, detected-or-reported, causal links. Delay events, integrity signals, incidents and instructions are all `Event` subtypes.

**6. `Entity`** — any legal or natural person. Attributes: identifiers, jurisdiction, relationships, roles, screening status. The graph over this object is what makes collusion detection possible.

**7. `Signal`** — a detected anomaly. Attributes: detector, severity, confidence, supporting evidence set, false-positive feedback, disposition, escalation state.

**8. `Ledger Entry`** — the append-only, hash-chained record of every state change to any of the above. Never updated, only appended. This is what makes the system's output admissible rather than merely informative.

**Design rule:** `Assertion` and `Evidence` must never be created by the same actor through the same pathway. The moment the contractor can author both sides of a reconciliation, the product is worthless. This constraint is the entire architecture.

---

## 5. BUILD SEQUENCE

**Phase 0 — Ingest and prove (weeks 1-12).**
Build M6 and M1 only. Ingest one real project's data from Procore or Aconex via API. Hash everything at ingest. Produce a single output: a reconciliation report showing certified quantities against reality-capture evidence. If the divergences are real and material, you have a business. If they are not, you have learned that cheaply.

**Phase 1 — Signal (months 3-9).**
M2, M3, M4. Run the integrity detectors retrospectively over historical procurement data from a willing public client or audit institution. Retrospective detection on known cases is the only credible proof of a detection product. Publish methodology; do not publish findings.

**Phase 2 — Workspace (months 6-12).**
M5. The auditor, independent reviewer and regulator roles. This is where the revenue model becomes legible: you are not selling software to a contractor, you are selling assurance capacity to an oversight body.

**Phase 3 — Commercial depth (months 9-20).**
M7 and M8. Measurement and contract intelligence are what make the reconciliation contractually meaningful rather than merely statistical. A variance is an observation; a variance mapped to a FIDIC sub-clause with a live time bar is an action.

**Phase 4 — Everything else, driven by contract requirements.**
Tiers 3 and 4 are built in the order your first three institutional customers contractually require them. Do not speculate.

---

## 6. THE THREE THINGS THAT KILL THIS

**1. Evidence independence collapses.** If the only evidence available is what the contractor uploads, you are a reporting tool with extra steps. Independent evidence streams — telematics, biometrics, satellite, drone, bank data, corporate registries, access control — must be contractually mandated at project setup or the product degrades to opinion.

**2. False positive fatigue.** An integrity detector with poor precision gets switched off within one quarter. Every detector needs a measured precision figure before it ships, a reviewer feedback loop, and a severity threshold tuned to the reviewer's actual capacity. Ship five detectors that work rather than fifty that fire.

**3. Procurement cycle length.** Public clients and DFIs buy on 12-24 month cycles with formal tenders. Cash runway must assume no institutional revenue for two years. The commercial answer is a services-led entry — deliver the analysis as an engagement first, productise second, which also solves the evidence-access problem because engagement scope can mandate it.

---

## 7. WHAT TO DO NEXT

The single highest-value next artefact is not more specification. It is a **retrospective detection run**: take one completed public project with a known integrity outcome, ingest its procurement and payment record, and measure how many of Domain A's 114 detectors would have fired before the outcome was known.

That result — a precision and recall figure against a known case — is the only thing that converts this document from a plan into a company.

---

*End of specification. Volume I: 804 enumerated Procore functions across 8 sections. Volume II: 1,100 enumerated absent functions across 26 domains. Volume III: 19 modules, 8 data primitives, 5 build phases.*
