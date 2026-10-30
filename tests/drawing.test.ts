import test from "node:test";
import assert from "node:assert/strict";
import {canvasPoint,commitStroke,undoStroke,redoStroke,type DrawingHistory} from "../apps/sketchbook/app/drawing.ts";
import type {SketchStroke} from "../packages/core/src/index.ts";
const stroke=(id:string):SketchStroke=>({id,tool:"pen",color:"#333333",width:4,points:[{x:10,y:20,pressure:0.5}]});
test("pointer coordinates map resized paper into bounded original coordinates",()=>{
  const rect={left:100,top:30,width:600,height:400};
  assert.deepEqual(canvasPoint(400,230,rect,"mouse",0),{x:600,y:400,pressure:0.5});
  assert.deepEqual(canvasPoint(-40,900,rect,"pen",2),{x:0,y:800,pressure:1});
  assert.equal(canvasPoint(400,230,rect,"pen",0.8).pressure,0.8);
});
test("undo redo preserve source stroke order and a new stroke clears redo",()=>{
  let history:DrawingHistory={strokes:[],redo:[]};history=commitStroke(history,stroke("a"));history=commitStroke(history,stroke("b"));
  history=undoStroke(history);assert.deepEqual(history.strokes.map(s=>s.id),["a"]);
  history=redoStroke(history);assert.deepEqual(history.strokes.map(s=>s.id),["a","b"]);
  history=undoStroke(history);history=commitStroke(history,stroke("c"));
  assert.deepEqual(history.strokes.map(s=>s.id),["a","c"]);assert.equal(history.redo.length,0);assert.equal(redoStroke(history),history);
});
