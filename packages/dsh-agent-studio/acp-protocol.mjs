import {fields,requireThat,StudioError} from './store.mjs';

const bounded=(value,max=8192)=>{requireThat(typeof value==='string' && value.length<=max && !value.includes('\0'),'acp-text-invalid');return value;};
const present=value=>value!==undefined && value!==null;
function keys(value,allowed,required=[]) {
  requireThat(value && typeof value==='object' && !Array.isArray(value),'acp-schema-invalid');
  fields(value,allowed,required);
}
function optionsOf(schema) {
  requireThat(!(present(schema.enum) && present(schema.oneOf)),'acp-form-ambiguous-enum');
  if(present(schema.enum)) {
    requireThat(Array.isArray(schema.enum) && schema.enum.length>0 && schema.enum.length<=32,'acp-form-enum-limit');
    const choices=schema.enum.map(value=>({value:bounded(value,256),label:value||'(empty string)'}));
    requireThat(new Set(choices.map(v=>v.value)).size===choices.length,'acp-form-duplicate-option');
    requireThat(new Set(choices.map(v=>v.label)).size===choices.length,'acp-form-duplicate-label');return choices;
  }
  const options=schema.oneOf??schema.anyOf;
  requireThat(Array.isArray(options) && options.length>0 && options.length<=32,'acp-form-enum-required');
  const choices=options.map((option,index)=>{
    keys(option,['const','title','description','_meta'],['const','title']);
    const value=bounded(option.const,256),title=bounded(option.title,256);
    return {value,label:`${index+1}. ${title} (${value})`};
  });
  requireThat(new Set(choices.map(v=>v.value)).size===choices.length,'acp-form-duplicate-option');return choices;
}
export function permissionProjection(params) {
  requireThat(Array.isArray(params.options) && params.options.length<=16,'acp-permission-options-invalid');
  const once=params.options.filter(option=>['allow_once','reject_once'].includes(option.kind));
  requireThat(once.filter(o=>o.kind==='allow_once').length===1 && once.filter(o=>o.kind==='reject_once').length===1,'acp-permission-once-options-unsupported');
  requireThat(new Set(params.options.map(o=>o.optionId)).size===params.options.length,'acp-permission-duplicate-option');
  for(const option of once) {bounded(option.optionId,256);bounded(option.name,256);}
  requireThat(typeof params.toolCall?.toolCallId==='string','acp-permission-tool-id-required');
  bounded(params.toolCall.toolCallId,256);
  return {allow:once.find(o=>o.kind==='allow_once'),reject:once.find(o=>o.kind==='reject_once'),title:bounded(params.toolCall.title??'ACP tool request',2048)};
}
export function formProjection(params) {
  requireThat(params.mode==='form','acp-elicitation-mode-unsupported');
  bounded(params.message,4096);
  const schema=params.requestedSchema;keys(schema,['type','title','description','properties','required','_meta'],['properties']);
  requireThat(schema.type===undefined || schema.type==='object','acp-form-object-required');
  keys(schema.properties,Object.keys(schema.properties??{}));
  const entries=Object.entries(schema.properties),required=schema.required??[];
  requireThat(entries.length>0 && entries.length<=8 && Array.isArray(required) && new Set(required).size===required.length && required.every(key=>Object.hasOwn(schema.properties,key)),'acp-form-fields-invalid');
  const definitions=entries.map(([id,property])=>{
    requireThat(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(id) && !['__proto__','constructor','prototype'].includes(id),'acp-form-field-name-invalid');
    const common=['type','title','description','default','_meta'];
    const extra={string:['minLength','maxLength','pattern','format','enum','oneOf'],number:['minimum','maximum'],integer:['minimum','maximum'],boolean:[],array:['minItems','maxItems','items']}[property?.type];
    requireThat(extra,'acp-form-type-unsupported');keys(property,[...common,...extra],['type']);
    requireThat(!present(property.pattern) && !present(property.format),'acp-form-constraint-unsupported');
    for(const key of ['minLength','maxLength','minItems','maxItems']) if(present(property[key])) requireThat(Number.isSafeInteger(property[key]) && property[key]>=0 && property[key]<=8192,'acp-form-bounds-invalid');
    for(const key of ['minimum','maximum']) if(present(property[key])) requireThat(Number.isFinite(property[key]),'acp-form-bounds-invalid');
    for(const [min,max] of [['minLength','maxLength'],['minItems','maxItems'],['minimum','maximum']]) if(present(property[min]) && present(property[max])) requireThat(property[min]<=property[max],'acp-form-bounds-invalid');
    let choices=[];
    if(property.type==='boolean') choices=[{label:'True',value:true},{label:'False',value:false}];
    if(property.type==='string' && (present(property.enum)||present(property.oneOf))) choices=optionsOf(property);
    if(property.type==='array') {
      const items=property.items;keys(items,['type','enum','anyOf','_meta']);
      requireThat(items.type===undefined || items.type==='string','acp-form-type-unsupported');
      requireThat(!(present(items.enum)&&present(items.anyOf)),'acp-form-ambiguous-enum');choices=optionsOf(items);
    }
    const title=bounded(property.title??id,512),description=bounded(property.description??'',2048);
    return {id,type:property.type,required:required.includes(id),property,choices,question:{id,question:`${params.message}\n${title}${required.includes(id)?' (required)':' (optional)'}${description?' — '+description:''}`,options:choices.map(choice=>({label:choice.label})),multiSelect:property.type==='array'}};
  });
  return {questions:definitions.map(d=>d.question),definitions,schema};
}
export function formContent(payload,answer) {
  const {definitions}=formProjection(payload.acp_request),content=Object.create(null);
  requireThat(Array.isArray(answer?.answers) && answer.answers.length===definitions.length,'invalid-question-answer');
  for(const field of definitions) {
    const response=answer.answers.find(a=>a.id===field.id);requireThat(response && Array.isArray(response.selected),'invalid-question-answer');
    let value;
    if(field.choices.length) {
      requireThat(!response.custom,'acp-form-custom-enum-denied');
      const chosen=response.selected.map(label=>{const option=field.choices.find(o=>o.label===label);requireThat(option,'acp-form-option-invalid');return option.value;});
      requireThat(new Set(chosen).size===chosen.length,'acp-form-option-invalid');
      if(field.type==='array') value=chosen.length || field.required?chosen:undefined;
      else {requireThat(chosen.length<=1,'acp-form-option-invalid');value=chosen[0];}
    } else {
      requireThat(response.selected.length===0,'acp-form-option-invalid');
      if(response.custom!==undefined) {
        const raw=bounded(response.custom);
        if(field.type==='string') value=raw;
        else {requireThat(raw.trim()!=='' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw),'acp-form-number-invalid');value=Number(raw);requireThat(Number.isFinite(value) && (field.type!=='integer'||Number.isSafeInteger(value)),'acp-form-number-invalid');}
      }
    }
    requireThat(value!==undefined || !field.required,'acp-form-required');if(value===undefined) continue;
    const p=field.property;
    if(typeof value==='string') {const length=Array.from(value).length;requireThat(length>=(p.minLength??0) && length<=(p.maxLength??8192),'acp-form-length-invalid');}
    if(typeof value==='number') requireThat(value>=(p.minimum??-Infinity) && value<=(p.maximum??Infinity),'acp-form-number-invalid');
    if(Array.isArray(value)) requireThat(value.length>=(p.minItems??0) && value.length<=(p.maxItems??32),'acp-form-items-invalid');
    content[field.id]=value;
  }
  return content;
}
export function controlResponse(row,answer) {
  const payload=JSON.parse(row.payload_json);
  if(row.kind==='approval') {
    const options=permissionProjection(payload.acp_request);
    requireThat(['allowed-once','rejected'].includes(answer),'invalid-approval-answer');
    return {outcome:{outcome:'selected',optionId:(answer==='allowed-once'?options.allow:options.reject).optionId}};
  }
  if(row.kind==='question') return {action:'accept',content:formContent(payload,answer)};
  throw new StudioError('acp-control-kind-unsupported');
}
