/**
 * Hand-written IFC STEP fixture shared by the extractor unit tests and the
 * module integration tests. It is deliberately awkward: a wrapped entity, a
 * name containing a semicolon and an escaped quote, millimetre units, a full
 * spatial hierarchy, property sets, quantities, a classification and a type.
 */
/* ------------------------------------------------------------------ */
/* Fixture: a small but structurally complete IFC                      */
/* ------------------------------------------------------------------ */

export const WALL_A_GUID = "2O2Fr$t4X7Zf8NOew3FLOH";
export const WALL_B_GUID = "1ABCDEFGHIJKLMNOPQRSTU";
export const DOOR_GUID = "3ZYXWVUTSRQPONMLKJIHGF";
export const SITE_GUID = "0SITE00000000000000AAA";
export const BUILDING_GUID = "0BLDG00000000000000AAA";
export const STOREY_GUID = "0STOREY0000000000000AA";
export const SPACE_GUID = "0SPACE00000000000000AA";

/**
 * Wall A is wrapped across three physical lines and its name contains a
 * semicolon and an escaped quote — the two things the old line-based parser
 * silently dropped.
 */
export const IFC_FIXTURE = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('fixture.ifc','2026-08-21T00:00:00',(''),(''),'','','');",
  "ENDSEC;",
  "DATA;",
  "#1=IFCOWNERHISTORY(#2,#3,$,.ADDED.,$,$,$,1234567890);",
  "#2=IFCPERSONANDORGANIZATION(#4,#5,$);",
  "#5=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);",
  /* spatial structure */
  `#100=IFCSITE('${SITE_GUID}',#1,'Riverside Site',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);`,
  `#101=IFCBUILDING('${BUILDING_GUID}',#1,'Tower A',$,$,#20,$,$,.ELEMENT.,$,$,$);`,
  `#102=IFCBUILDINGSTOREY('${STOREY_GUID}',#1,'Level 01',$,$,#20,$,$,.ELEMENT.,3000.);`,
  `#103=IFCSPACE('${SPACE_GUID}',#1,'Room 1.01',$,$,#20,$,$,.ELEMENT.,.INTERNAL.,$);`,
  "#110=IFCRELAGGREGATES('0AGG10000000000000AAAA',#1,$,$,#100,(#101));",
  "#111=IFCRELAGGREGATES('0AGG20000000000000AAAA',#1,$,$,#101,(#102));",
  "#112=IFCRELAGGREGATES('0AGG30000000000000AAAA',#1,$,$,#102,(#103));",
  /* elements — wall A wrapped over three lines */
  `#10=IFCWALLSTANDARDCASE('${WALL_A_GUID}',#1,`,
  "  'Wall; North ''A''',$,$,#20,#21,",
  "  'TAG-W1');",
  `#11=IFCWALL('${WALL_B_GUID}',#1,'Wall B',$,$,#30,#22,'TAG-W2');`,
  `#12=IFCDOOR('${DOOR_GUID}',#1,'Door, Main Entrance',$,$,#30,#23,'TAG-D1',2100.,900.);`,
  /* placements: wall B and the door sit 5 m east and 3 m up */
  "#20=IFCLOCALPLACEMENT($,#24);",
  "#24=IFCAXIS2PLACEMENT3D(#25,$,$);",
  "#25=IFCCARTESIANPOINT((0.,0.,0.));",
  "#30=IFCLOCALPLACEMENT(#20,#31);",
  "#31=IFCAXIS2PLACEMENT3D(#32,$,$);",
  "#32=IFCCARTESIANPOINT((5000.,0.,3000.));",
  /* containment */
  "#300=IFCRELCONTAINEDINSPATIALSTRUCTURE('0CNT10000000000000AAAA',#1,$,$,(#10,#11,#12),#102);",
  /* property set on wall A */
  "#400=IFCPROPERTYSET('0PST10000000000000AAAA',#1,'Pset_WallCommon',$,(#401));",
  "#401=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2 HR'),$);",
  "#402=IFCRELDEFINESBYPROPERTIES('0RDP10000000000000AAAA',#1,$,$,(#10),#400);",
  /* quantities on both walls */
  "#410=IFCELEMENTQUANTITY('0EQT10000000000000AAAA',#1,'Qto_WallBaseQuantities',$,$,(#411,#412,#413));",
  "#411=IFCQUANTITYLENGTH('Length',$,$,4000.);",
  "#412=IFCQUANTITYLENGTH('Width',$,$,200.);",
  "#413=IFCQUANTITYLENGTH('Height',$,$,3000.);",
  "#414=IFCRELDEFINESBYPROPERTIES('0RDP20000000000000AAAA',#1,$,$,(#10,#11),#410);",
  /* classification + type on wall A */
  "#420=IFCCLASSIFICATIONREFERENCE('','Ss_25_10_30_60','Wall systems',$);",
  "#421=IFCRELASSOCIATESCLASSIFICATION('0RAC10000000000000AAAA',#1,$,$,(#10),#420);",
  "#430=IFCWALLTYPE('0WTY10000000000000AAAA',#1,'Basic Wall:Interior 100mm',$,$,$,$,$,$,.STANDARD.);",
  "#431=IFCRELDEFINESBYTYPE('0RDT10000000000000AAAA',#1,$,$,(#10,#11),#430);",
  "ENDSEC;",
  "END-ISO-10303-21;",
].join("\n");

