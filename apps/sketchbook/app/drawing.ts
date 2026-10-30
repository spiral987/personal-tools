import type {SketchPoint,SketchStroke} from "@personal-tools/core";
export const PAPER_WIDTH=1200,PAPER_HEIGHT=800;
export type DrawingHistory={strokes:SketchStroke[];redo:SketchStroke[]};
export function canvasPoint(clientX:number,clientY:number,rect:{left:number;top:number;width:number;height:number},pointerType:string,pressure:number):SketchPoint{
  const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,Number.isFinite(value)?value:min));
  return {x:clamp((clientX-rect.left)/Math.max(1,rect.width)*PAPER_WIDTH,0,PAPER_WIDTH),y:clamp((clientY-rect.top)/Math.max(1,rect.height)*PAPER_HEIGHT,0,PAPER_HEIGHT),pressure:pointerType==="pen"?clamp(pressure||0.5,0.05,1):0.5};
}
export function commitStroke(history:DrawingHistory,stroke:SketchStroke):DrawingHistory{return {strokes:[...history.strokes,stroke],redo:[]};}
export function undoStroke(history:DrawingHistory):DrawingHistory{if(!history.strokes.length)return history;return {strokes:history.strokes.slice(0,-1),redo:[...history.redo,history.strokes.at(-1)!]};}
export function redoStroke(history:DrawingHistory):DrawingHistory{if(!history.redo.length)return history;return {strokes:[...history.strokes,history.redo.at(-1)!],redo:history.redo.slice(0,-1)};}
export function paintStroke(context:CanvasRenderingContext2D,stroke:SketchStroke){
  if(!stroke.points.length)return;
  context.save();context.globalCompositeOperation=stroke.tool==="eraser"?"destination-out":"source-over";
  context.strokeStyle=stroke.color;context.fillStyle=stroke.color;context.lineCap="round";context.lineJoin="round";
  const size=(point:SketchPoint)=>stroke.width*(0.45+point.pressure*1.1);
  if(stroke.points.length===1){const point=stroke.points[0];context.beginPath();context.arc(point.x,point.y,size(point)/2,0,Math.PI*2);context.fill();}
  else for(let index=1;index<stroke.points.length;index++){
    const previous=stroke.points[index-1],point=stroke.points[index];context.lineWidth=(size(previous)+size(point))/2;
    context.beginPath();context.moveTo(previous.x,previous.y);context.lineTo(point.x,point.y);context.stroke();
  }
  context.restore();
}
export function paintDrawing(canvas:HTMLCanvasElement,strokes:SketchStroke[],whiteBackground=false){
  const context=canvas.getContext("2d");if(!context)return;
  context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,canvas.width,canvas.height);
  context.setTransform(canvas.width/PAPER_WIDTH,0,0,canvas.height/PAPER_HEIGHT,0,0);
  for(const stroke of strokes)paintStroke(context,stroke);
  if(whiteBackground){context.save();context.globalCompositeOperation="destination-over";context.fillStyle="#ffffff";context.fillRect(0,0,PAPER_WIDTH,PAPER_HEIGHT);context.restore();}
}
export async function drawingPng(strokes:SketchStroke[]):Promise<Blob>{
  const canvas=document.createElement("canvas");canvas.width=PAPER_WIDTH;canvas.height=PAPER_HEIGHT;paintDrawing(canvas,strokes,true);
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("PNGを書き出せませんでした。")),"image/png"));
}
