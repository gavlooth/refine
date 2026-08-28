#!/usr/bin/env bun
// Iteratively expand teaching records outward through prerequisite dependencies.
// Usage: ./expand-teaching-records.mjs INPUT.json OUTPUT.json RUN_DIRECTORY
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { denseParagraphs } from "./generate-document.mjs";
import { writeJsonAtomic } from "./refine.mjs";

const cfg = {
  batchSize: envInt("REFINE_TEACHING_BATCH_SIZE", 8, 1, 24),
  concurrency: envInt("REFINE_CONCURRENCY", 16, 1, 16),
  timeout: envInt("REFINE_TIMEOUT_SECONDS", 180, 30, 900),
  maxDepth: envInt("REFINE_TEACHING_MAX_DEPTH", 2, 0, 4),
  model: Bun.env.REFINE_MODEL ?? "openai-codex/gpt-5.6-luna",
  thinking: Bun.env.REFINE_THINKING ?? "medium",
  tier: Bun.env.REFINE_SERVICE_TIER ?? "priority",
  baseline: Bun.env.REFINE_READER_BASELINE ?? "technically literate beginner",
};
const ROLES = new Set(["statement","definition","mechanism","prerequisite","intuition","derivation","example","limitation","evidence_interpretation"]);
function envInt(name, fallback, min, max) { const value=Number(Bun.env[name]??fallback); if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(`${name} must be ${min}-${max}`); return value; }
function chunks(items,size){return Array.from({length:Math.ceil(items.length/size)},(_,i)=>items.slice(i*size,(i+1)*size));}
function norm(value){return typeof value==="string"?value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/g," "):"";}
function parseJson(text){return JSON.parse(text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]??text.trim());}
async function parallel(items,limit,mapper){let cursor=0;const output=new Array(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const i=cursor++;if(i>=items.length)return;output[i]=await mapper(items[i],i);}}));return output;}
function generatedId(chapter,concept){return`teach-generated-${new Bun.CryptoHasher("sha256").update(`${chapter}\u0000${norm(concept)}`).digest("hex").slice(0,16)}`;}

function validateExpansion(value,records){
  if(!value||!Array.isArray(value.items)||value.items.length!==records.length)throw new Error(`Expected ${records.length} items`);
  const expected=new Set(records.map(r=>r.id));const seen=new Set();
  return value.items.map(item=>{
    if(!expected.has(item?.recordId)||seen.has(item.recordId)||!Array.isArray(item.units))throw new Error(`Invalid record ${item?.recordId}`);seen.add(item.recordId);
    const record=records.find(r=>r.id===item.recordId);
    const units=item.units.map(unit=>({role:unit?.role,basis:unit?.basis,text:typeof unit?.text==="string"?unit.text.trim():"",requires:[...new Set((unit?.requires??[]).filter(x=>typeof x==="string"&&x.trim()).map(x=>x.trim()))].slice(0,3),citationRequired:unit?.citationRequired===true}));
    if(units.some(unit=>!ROLES.has(unit.role)||!["source","common_knowledge"].includes(unit.basis)||!unit.text||denseParagraphs(unit.text).length))throw new Error(`Invalid unit ${item.recordId}`);
    if(record.sourceNodeId&&units.filter(unit=>unit.basis==="source").length<record.minimumTeachingUnits)throw new Error(`Insufficient source units ${item.recordId}`);
    if(!record.sourceNodeId&&!units.length)throw new Error(`Missing definition ${item.recordId}`);
    return{recordId:item.recordId,units};
  });
}

function applyExpansion(file,items,depth){
  const byId=new Map(file.records.map(record=>[record.id,record]));const known=new Set(file.records.flatMap(record=>record.sourceDefines??[]).map(norm));let sequence=file.summary.teachingUnitCount??file.records.reduce((sum,record)=>sum+record.teachingUnits.length,0);let generated=0;
  for(const item of items){const record=byId.get(item.recordId);if(!record)continue;record.teachingUnits=item.units.map(unit=>({id:`teaching-unit-${String(++sequence).padStart(7,"0")}`,role:unit.role,text:unit.text,provenance:unit.basis==="source"?"source_decomposition":"model_common_knowledge",epistemicStatus:unit.citationRequired?"citation_needed":unit.basis==="source"?"source_grounded":"model_common_knowledge",citations:[],derivedFrom:record.id,expansionDepth:depth,requires:unit.requires}));record.status="expanded";record.expansionDepth=depth;if(depth>=cfg.maxDepth)continue;
    for(const unit of record.teachingUnits)for(const concept of unit.requires){const key=norm(concept);if(!key||known.has(key))continue;known.add(key);const id=generatedId(record.chapter,concept);let prerequisite=byId.get(id);if(!prerequisite){prerequisite={id,sourceNodeId:null,sourceUnitIds:[],chapter:record.chapter,kind:"model_prerequisite",sourceAnchor:concept,sourceDefines:[concept],sourceRequires:[],densityScore:null,dense:false,status:"expansion_required",minimumTeachingUnits:1,teachingUnits:[],generated:true,expansionDepth:depth+1,requiredBy:[unit.id]};file.records.push(prerequisite);byId.set(id,prerequisite);generated++;}else prerequisite.requiredBy=[...new Set([...(prerequisite.requiredBy??[]),unit.id])];file.dependencies.push({from:prerequisite.id,to:record.id,relation:"enables",reason:`${record.id} requires ${concept}`});}}
  file.summary.teachingUnitCount=sequence;file.summary.generatedPrerequisiteCount=(file.summary.generatedPrerequisiteCount??0)+generated;return generated;
}

async function callBatch(records,runDir,depth,index){
  const stem=`depth-${depth}-batch-${String(index+1).padStart(4,"0")}`;const promptPath=resolve(runDir,`${stem}.prompt.txt`);
  const prompt=`Return JSON only: {"items":[{"recordId":"...","units":[{"role":"statement|definition|mechanism|prerequisite|intuition|derivation|example|limitation|evidence_interpretation","basis":"source|common_knowledge","text":"focused plain-prose teaching unit","requires":["undefined prerequisite"],"citationRequired":false}]}]}.

Expand every record for a ${cfg.baseline}. Source records require at least minimumTeachingUnits source-basis units that jointly preserve every claim, qualification, citation label, and condition in sourceAnchor. Add common-knowledge units when useful. Generated prerequisite records must define their concept and list only prerequisites still needed by the reader. One conceptual move and at most three sentences per unit. Common textbook definitions need no citation; measurements, source-specific results, attribution, disputed claims, and numerical facts require citationRequired true. Return exactly one item per recordId.

${JSON.stringify(records.map(record=>({recordId:record.id,chapter:record.chapter,kind:record.kind,sourceAnchor:record.sourceAnchor,minimumTeachingUnits:record.minimumTeachingUnits,requires:record.sourceRequires})),null,2)}`;
  await Bun.write(promptPath,prompt);const args=["omp","-p","--mode","text","--no-session","--no-tools","--no-extensions","--no-skills","--no-rules","--max-time",`${cfg.timeout}s`,"--model",cfg.model,"--thinking",cfg.thinking,"--service-tier",cfg.tier,`@${promptPath}`];const child=Bun.spawn(args,{stdout:"pipe",stderr:"pipe"});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},(cfg.timeout+5)*1000);const[stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timer);await Promise.all([Bun.write(resolve(runDir,`${stem}.stdout.log`),stdout),Bun.write(resolve(runDir,`${stem}.stderr.log`),stderr)]);if(timedOut||exitCode!==0)throw new Error(timedOut?"timeout":`exit ${exitCode}: ${stderr.trim()}`);const items=validateExpansion(parseJson(stdout),records);await writeJsonAtomic(resolve(runDir,`${stem}.json`),{depth,batch:index+1,items});return items;
}

async function main(){
  const[inputArg,outputArg,runArg]=Bun.argv.slice(2);if(!inputArg||!outputArg||!runArg)throw new Error("Usage: ./expand-teaching-records.mjs INPUT.json OUTPUT.json RUN_DIRECTORY");const file=JSON.parse(await Bun.file(resolve(inputArg)).text());const runDir=resolve(runArg);await mkdir(runDir,{recursive:true});const issues=[];
  for(let depth=0;depth<=cfg.maxDepth;depth++){const targets=file.records.filter(record=>record.status==="expansion_required"&&(record.expansionDepth??0)===depth);const work=chunks(targets,cfg.batchSize);for(let start=0;start<work.length;start+=cfg.concurrency){const wave=work.slice(start,start+cfg.concurrency);const results=await parallel(wave,wave.length,(batch,offset)=>callBatch(batch,runDir,depth,start+offset).then(items=>({items})).catch(error=>({error})));for(const[offset,result]of results.entries()){if(result.error)issues.push({depth,batch:start+offset+1,recordIds:wave[offset].map(record=>record.id),reason:result.error.message});else applyExpansion(file,result.items,depth);}file.summary.expansionIssues=issues;file.summary.expandedRecordCount=file.records.filter(record=>record.status==="expanded").length;file.summary.pendingRecordCount=file.records.filter(record=>record.status==="expansion_required").length;await writeJsonAtomic(resolve(outputArg),file);console.error(`depth ${depth} wave ${Math.floor(start/cfg.concurrency)+1}: ${file.summary.expandedRecordCount} expanded, ${file.summary.pendingRecordCount} pending`);}}
}
if(import.meta.main)await main();
export{applyExpansion,validateExpansion};
