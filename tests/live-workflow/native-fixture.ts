/** Synthetic Responses stream consumed by the real CLI; never calls a provider. */
export function fixtureResponse(model:string, output:unknown):Response {
 const text=JSON.stringify(output),item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
 const response={id:'resp_fixture',object:'response',created_at:1,status:'completed',model,output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
 const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
 return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}
