import { expect, test } from "bun:test";
import { applyExpansion, validateExpansion } from "../bin/expand-teaching-records.mjs";

function fixture() { return { records:[{id:"r1",sourceNodeId:"n1",sourceUnitIds:["u1"],chapter:"Chapter 1",sourceAnchor:"Beta reduction substitutes an argument for a bound variable.",sourceDefines:["beta reduction"],sourceRequires:[],status:"expansion_required",minimumTeachingUnits:2,teachingUnits:[],expansionDepth:0}],dependencies:[],summary:{teachingUnitCount:0,generatedPrerequisiteCount:0} }; }

test("expands a source record and creates outward prerequisite records",()=>{
  const file=fixture();const items=validateExpansion({items:[{recordId:"r1",units:[{role:"statement",basis:"source",text:"Beta reduction replaces a bound variable with an argument term.",requires:["bound variable","argument term"],citationRequired:false},{role:"mechanism",basis:"source",text:"The replacement occurs inside the body of a lambda abstraction.",requires:["lambda abstraction"],citationRequired:false},{role:"prerequisite",basis:"common_knowledge",text:"Substitution must avoid capturing free variables.",requires:["free variable"],citationRequired:false}]}]},file.records);applyExpansion(file,items,0);
  expect(file.records[0]).toMatchObject({status:"expanded",expansionDepth:0});
  expect(file.records[0].teachingUnits).toHaveLength(3);
  expect(file.records.filter(record=>record.generated)).toHaveLength(4);
  expect(file.dependencies).toHaveLength(4);
});
