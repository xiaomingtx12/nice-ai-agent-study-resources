import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React, {act} from "react";
import {createRoot} from "react-dom/client";
import {JSDOM} from "jsdom";

const require = createRequire(import.meta.url);
async function harness() {
  const dom = new JSDOM("<div id=app></div>", {url: "http://localhost", pretendToBeVisual: true});
  const previous = {};
  const globals = {window: dom.window, document: dom.window.document, MouseEvent: dom.window.MouseEvent, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, Element: dom.window.Element, DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer, getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), ResizeObserver: class {observe() {} disconnect() {}}, IS_REACT_ACT_ENVIRONMENT: true};
  for (const [key, value] of Object.entries(globals)) {previous[key] = globalThis[key]; globalThis[key] = value;}
  dom.window.matchMedia = () => ({matches: true, addEventListener() {}, removeEventListener() {}});
  for (const key of ["offsetWidth", "clientWidth"]) Object.defineProperty(dom.window.HTMLElement.prototype, key, {configurable: true, get() {return this.className.includes("react-transform-component") ? 320 : 640;}});
  for (const key of ["offsetHeight", "clientHeight"]) Object.defineProperty(dom.window.HTMLElement.prototype, key, {configurable: true, get() {return this.className.includes("react-transform-component") ? 180 : 360;}});
  dom.window.HTMLElement.prototype.getBoundingClientRect = function() {return {x:0,y:0,left:0,top:0,width:this.clientWidth,height:this.clientHeight,right:this.clientWidth,bottom:this.clientHeight};};
  const lib = require("react-zoom-pan-pinch");
  let controls;
  const module = {exports:{}};
  const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInNewContext(js, {...globals, module, exports:module.exports, require(name) {
    if (name.endsWith(".css")) return new Proxy({}, {get:(_,key)=>String(key)});
    if (name === "react-zoom-pan-pinch") return {...lib, TransformWrapper: props => React.createElement(lib.TransformWrapper, {...props, onInit: ref => {controls=ref;}})};
    return require(name);
  }});
  const root=createRoot(document.getElementById("app"));
  await act(async()=>root.render(React.createElement(module.exports.default,{result:{svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 288 148"><rect width="288" height="148"/></svg>',width:288,height:148}})));
  const canvas=document.querySelector("[aria-label=图表画布]");
  const wrapper=document.querySelector(".react-transform-component");
  const mouse=(target,type,x,y)=>target.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:type==="mouseup"?0:1}));
  return {controls, canvas, dom, async enable() {await act(async()=>[...document.querySelectorAll("button")].find(b=>b.textContent==="拖动").click());},
    async drag() {await act(async()=>{mouse(wrapper,"mousedown",100,100);mouse(dom.window,"mousemove",160,130);mouse(dom.window,"mouseup",160,130);});},
    async wheel(deltaY) {let event;await act(async()=>{event=new dom.window.WheelEvent("wheel",{bubbles:true,cancelable:true,clientX:200,clientY:150,deltaY});canvas.dispatchEvent(event);await new Promise(resolve=>dom.window.requestAnimationFrame(resolve));});return event;},
    async close() {await act(async()=>root.unmount());dom.window.close();Object.assign(globalThis,previous);},
  };
}

test("a fitted diagram follows the pointer even when it is smaller than the canvas",async()=>{
  const h=await harness();try {await h.enable();const before={...h.controls.instance.state};await h.drag();const after=h.controls.instance.state;assert.ok(Math.abs(after.positionX-before.positionX-60)<1, `horizontal movement: ${after.positionX-before.positionX}`);assert.ok(Math.abs(after.positionY-before.positionY-30)<1);} finally {await h.close();}
});
test("one wheel notch changes zoom gently and reading mode leaves page scrolling alone",async()=>{
  const h=await harness();try {const event=await h.wheel(-100);assert.equal(event.defaultPrevented,false);await h.enable();const before=h.controls.instance.state.scale;await h.wheel(-100);const ratio=h.controls.instance.state.scale/before;assert.ok(ratio>1 && ratio<=1.15, `zoom ratio: ${ratio}`);} finally {await h.close();}
});
test("wheel zoom remains proportional at a small fitted scale and preserves the cursor anchor",async()=>{
  const h=await harness();try {
    await h.enable();
    await act(async()=>h.controls.setTransform(0,0,0.1,0));
    const before=h.controls.instance.state.scale;
    await h.wheel(-100);
    const after=h.controls.instance.state;
    assert.ok(after.scale/before>1 && after.scale/before<=1.1);
    assert.ok(Math.abs(after.positionX + 200*(after.scale/before-1))<0.01);
    await h.wheel(100);
    assert.ok(Math.abs(h.controls.instance.state.scale-before)<0.0001);
  } finally {await h.close();}
});

