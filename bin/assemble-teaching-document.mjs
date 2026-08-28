#!/usr/bin/env bun
// Assemble expanded teaching records deterministically in dependency order.
// Usage: ./assemble-teaching-document.mjs RECORDS.json OUTPUT.md REPORT.json
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { denseParagraphs } from "./generate-document.mjs";
import { splitDenseProse } from "./decompress-prose.mjs";

function wordCount(text) { return text.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)?.length ?? 0; }
function safeJson(value) { return JSON.stringify(value).replace(/--/g, "—"); }
function visibleMarkdown(markdown) { return markdown.replace(/<!--[\s\S]*?-->/g, ""); }
function citationLabels(text) { return [...new Set(text.match(/\[R\d+\]/g) ?? [])]; }
function rolePrefix(role) { return ({ prerequisite: "**Prerequisite.** ", example: "**Example.** ", limitation: "**Limitation.** ", evidence_interpretation: "**Evidence.** ", derivation: "**Derivation.** " })[role] ?? ""; }

function sectionOrder(records) { const order=[]; const seen=new Set(); for(const record of records){if(!seen.has(record.chapter)){seen.add(record.chapter);order.push(record.chapter);}} return order; }
function orderedRecords(records, dependencies) {
  const ids=new Set(records.map(record=>record.id));const incoming=new Map(records.map(record=>[record.id,0]));const outgoing=new Map(records.map(record=>[record.id,[]]));
  for(const edge of dependencies){if(ids.has(edge.from)&&ids.has(edge.to)&&edge.from!==edge.to){outgoing.get(edge.from).push(edge.to);incoming.set(edge.to,incoming.get(edge.to)+1);}}
  const index=new Map(records.map((record,i)=>[record.id,i]));const queue=records.filter(record=>incoming.get(record.id)===0).sort((a,b)=>index.get(a.id)-index.get(b.id));const output=[];
  while(queue.length){const record=queue.shift();output.push(record);for(const target of outgoing.get(record.id)){incoming.set(target,incoming.get(target)-1);if(incoming.get(target)===0){queue.push(records.find(candidate=>candidate.id===target));queue.sort((a,b)=>index.get(a.id)-index.get(b.id));}}}
  if(output.length<records.length)for(const record of records)if(!output.includes(record))output.push(record);return output;
}

function assembleTeachingDocument(file, title) {
  const sections=sectionOrder(file.records);const parts=[`# ${title}`];let renderedRecords=0;
  for(const section of sections){parts.push(`## ${section}`);const records=orderedRecords(file.records.filter(record=>record.chapter===section),file.dependencies);
    for(const record of records){const units=record.teachingUnits??[];parts.push(`<!-- refine:source ${safeJson({id:record.id,sourceNodeId:record.sourceNodeId,sourceUnitIds:record.sourceUnitIds,sourceAnchor:record.sourceAnchor,status:record.status})} -->`);
      if(!units.length){parts.push(`<!-- refine:issue ${safeJson({id:`issue-${record.id}`,type:"unexpanded_teaching_record",status:"open",action:"enrich_or_preserve",need:`Expand ${record.sourceAnchor}`,sourceUnitIds:record.sourceUnitIds})} -->`);continue;}
      renderedRecords++;
      for(const unit of units)parts.push(`${rolePrefix(unit.role)}${unit.text}`);
    }
  }
  for(const gap of file.gaps??[])if(!gap.resolutionStatus&&!gap.resolvedBy?.length)parts.push(`<!-- refine:issue ${safeJson({id:gap.gapId,type:gap.gapType,status:"open",action:"enrich_or_preserve",need:gap.need,sourceUnitIds:gap.sourceUnitIds})} -->`);
  const decompressed=splitDenseProse(`${parts.join("\n\n")}\n`).markdown;return{markdown:decompressed,renderedRecords,sectionCount:sections.length};
}

async function writeAtomic(path,text){await mkdir(dirname(path),{recursive:true});const temporary=`${path}.tmp-${process.pid}-${Date.now()}`;await Bun.write(temporary,text);await rename(temporary,path);}
async function main(){
  const[inputArg,outputArg,reportArg]=Bun.argv.slice(2);if(!inputArg||!outputArg||!reportArg)throw new Error("Usage: ./assemble-teaching-document.mjs RECORDS.json OUTPUT.md REPORT.json");const file=JSON.parse(await Bun.file(resolve(inputArg)).text());const source=file.graphSource&&await Bun.file(file.graphSource).exists()?await Bun.file(file.graphSource).text():"";const title=Bun.env.REFINE_DOCUMENT_TITLE??"Cognitively Decompressed Technical Guide";const result=assembleTeachingDocument(file,title);const visible=visibleMarkdown(result.markdown);const sourceRecords=file.records.filter(record=>record.sourceNodeId);const mapped=sourceRecords.filter(record=>record.teachingUnits?.length);const denseRecords=sourceRecords.filter(record=>record.dense);const expandedDense=denseRecords.filter(record=>record.status==="expanded"&&record.teachingUnits.length>=record.minimumTeachingUnits);const expectedCitations=citationLabels(sourceRecords.map(record=>record.sourceAnchor).join("\n"));const actualCitations=citationLabels(visible);const report={schemaVersion:"teaching-document-report/v1",recordCount:file.records.length,sourceRecordCount:sourceRecords.length,mappedSourceRecordCount:mapped.length,denseRecordCount:denseRecords.length,expandedDenseRecordCount:expandedDense.length,generatedPrerequisiteCount:file.records.filter(record=>record.generated).length,teachingUnitCount:file.records.reduce((sum,record)=>sum+(record.teachingUnits?.length??0),0),sectionCount:result.sectionCount,sourceWordCount:wordCount(source),outputWordCount:wordCount(visible),denseParagraphCount:denseParagraphs(result.markdown).length,expectedCitationLabels:expectedCitations,missingCitationLabels:expectedCitations.filter(label=>!actualCitations.includes(label)),pendingRecordCount:file.records.filter(record=>record.status==="expansion_required").length};report.accepted=report.mappedSourceRecordCount===report.sourceRecordCount&&report.expandedDenseRecordCount===report.denseRecordCount&&report.pendingRecordCount===0&&report.denseParagraphCount===0&&report.missingCitationLabels.length===0&&(!source||report.outputWordCount>=report.sourceWordCount);await writeAtomic(resolve(outputArg),result.markdown);await writeAtomic(resolve(reportArg),`${JSON.stringify(report,null,2)}\n`);console.error(JSON.stringify(report));if(!report.accepted)throw new Error("Teaching document failed decompression gates");}
if(import.meta.main)await main();
export{assembleTeachingDocument,orderedRecords,visibleMarkdown};
