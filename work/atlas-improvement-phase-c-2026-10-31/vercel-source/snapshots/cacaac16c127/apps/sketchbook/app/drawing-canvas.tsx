"use client";
import {useEffect,useRef,type PointerEvent} from "react";
import type {SketchStroke} from "@personal-tools/core";
import {canvasPoint,paintDrawing} from "./drawing";
type Props={strokes:SketchStroke[];tool:"pen"|"eraser";color:string;width:number;disabled?:boolean;onStroke:(stroke:SketchStroke)=>void;onDrawingChange?:(drawing:boolean)=>void;onLimit?:()=>void};
export function DrawingCanvas({strokes,tool,color,width,disabled,onStroke,onDrawingChange,onLimit}:Props){
  const element=useRef<HTMLCanvasElement>(null),active=useRef<{pointerId:number;stroke:SketchStroke;budget:number;limited:boolean}|null>(null);
  const latest=useRef({strokes,onStroke,onDrawingChange,onLimit});latest.current={strokes,onStroke,onDrawingChange,onLimit};
  function redraw(){if(element.current)paintDrawing(element.current,[...latest.current.strokes,...(active.current?[active.current.stroke]:[])]);}
  useEffect(()=>{
    const canvas=element.current;if(!canvas)return;
    const resize=()=>{const width=canvas.getBoundingClientRect().width;const ratio=Math.min(window.devicePixelRatio||1,3);canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(width*2/3*ratio));redraw();};
    resize();const observer=new ResizeObserver(resize);observer.observe(canvas);window.addEventListener("resize",resize);
    return()=>{observer.disconnect();window.removeEventListener("resize",resize);};
  },[]);
  useEffect(()=>{redraw();},[strokes]);
  useEffect(()=>{if(disabled){active.current=null;latest.current.onDrawingChange?.(false);redraw();}},[disabled]);
  function down(event:PointerEvent<HTMLCanvasElement>){
    if(disabled||active.current||event.button!==0||!event.isPrimary)return;
    const budget=20000-latest.current.strokes.reduce((count,stroke)=>count+stroke.points.length,0);
    if(budget<1||latest.current.strokes.length>=2000){latest.current.onLimit?.();return;}
    event.preventDefault();const point=canvasPoint(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect(),event.pointerType,event.pressure);
    // MDN Pointer Events drawing example: capture the pointer, even when it leaves the paper.
    // https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/Using_Pointer_Events
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current={pointerId:event.pointerId,budget,limited:false,stroke:{id:crypto.randomUUID(),tool,color,width,points:[point]}};
    latest.current.onDrawingChange?.(true);redraw();
  }
  function move(event:PointerEvent<HTMLCanvasElement>){
    const drawing=active.current;if(!drawing||drawing.pointerId!==event.pointerId)return;event.preventDefault();
    const point=canvasPoint(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect(),event.pointerType,event.pressure),last=drawing.stroke.points.at(-1)!;
    if(Math.hypot(point.x-last.x,point.y-last.y)>=0.75){if(drawing.stroke.points.length<drawing.budget)drawing.stroke.points.push(point);else if(!drawing.limited){drawing.limited=true;latest.current.onLimit?.();}}
    redraw();
  }
  function finish(event:PointerEvent<HTMLCanvasElement>,cancel=false){
    const drawing=active.current;if(!drawing||drawing.pointerId!==event.pointerId)return;
    if(!cancel)move(event);active.current=null;latest.current.onDrawingChange?.(false);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(!cancel)latest.current.onStroke(drawing.stroke);redraw();
  }
  return <canvas ref={element} className={`drawing-canvas tool-${tool}`} width={1200} height={800} aria-label="スケッチ用キャンバス。ペン、指、マウスで描けます。" onPointerDown={down} onPointerMove={move} onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onLostPointerCapture={event=>finish(event,true)}/>;
}
export function SketchThumbnail({strokes,label}:{strokes:SketchStroke[];label?:string}){
  const element=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{if(element.current)paintDrawing(element.current,strokes,true);},[strokes]);
  return <canvas ref={element} width={360} height={240} className="sketch-thumbnail" role="img" aria-label={label??"スケッチのプレビュー"}/>;
}
