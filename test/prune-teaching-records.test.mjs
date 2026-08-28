import { expect, test } from "bun:test";
import { isNavigationUnit, pruneTeachingRecords } from "../bin/prune-teaching-records.mjs";

test("removes navigation and duplicate source fallback while retaining reachable prerequisites",()=>{
  const graph={sourceUnits:[{id:"u0",kind:"prose",text:"- [Chapter](#chapter)",startLine:1},{id:"u1",kind:"prose",text:"Dense source.",startLine:2}],nodes:[{id:"nav",kind:"claim",text:"Chapter link.",sourceUnitIds:["u0"]},{id:"semantic",kind:"claim",text:"Small idea.",sourceUnitIds:["u1"]},{id:"fallback",kind:"source",text:"Dense source.",sourceUnitIds:["u1"],annotations:["repair_source_fallback"]}]};
  const file={records:[{id:"teach-nav",sourceNodeId:"nav",sourceUnitIds:["u0"],teachingUnits:[{text:"Chapter link."}]},{id:"teach-semantic",sourceNodeId:"semantic",sourceUnitIds:["u1"],teachingUnits:[{text:"Small idea."}]},{id:"teach-fallback",sourceNodeId:"fallback",sourceUnitIds:["u1"],teachingUnits:[{text:"Dense source."}]},{id:"prereq",sourceNodeId:null,generated:true,teachingUnits:[{text:"Prerequisite."}]}],dependencies:[{from:"prereq",to:"teach-semantic",relation:"enables"}],summary:{},gaps:[]};
  const output=pruneTeachingRecords(graph,file);
  expect(output.records.map(record=>record.id).sort()).toEqual(["prereq","teach-semantic"]);
  expect(output.summary.prunedRecordCount).toBe(2);
  expect(isNavigationUnit(graph.sourceUnits[0])).toBe(true);
});
