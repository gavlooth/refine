import { expect, test } from "bun:test";
import { assembleTeachingDocument, orderedRecords } from "../bin/assemble-teaching-document.mjs";

test("orders prerequisites first and preserves source anchors",()=>{
  const records=[{id:"dependent",chapter:"Chapter",sourceNodeId:"n2",sourceUnitIds:["u2"],sourceAnchor:"Dense source.",status:"expanded",teachingUnits:[{role:"statement",text:"Dependent statement."}]},{id:"prerequisite",chapter:"Chapter",sourceNodeId:null,sourceUnitIds:[],sourceAnchor:"Term",status:"expanded",teachingUnits:[{role:"definition",text:"Term is a prerequisite."}]}];
  expect(orderedRecords(records,[{from:"prerequisite",to:"dependent"}]).map(record=>record.id)).toEqual(["prerequisite","dependent"]);
  const output=assembleTeachingDocument({records,dependencies:[{from:"prerequisite",to:"dependent"}],gaps:[]},"Guide").markdown;
  expect(output.indexOf("Term is a prerequisite.")).toBeLessThan(output.indexOf("Dependent statement."));
  expect(output).toContain("refine:source");
  expect(output).toContain("Dense source.");
});
