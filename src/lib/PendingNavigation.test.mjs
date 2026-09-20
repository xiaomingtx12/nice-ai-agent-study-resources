import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';

const require = createRequire(import.meta.url);
function harness() {
  const dom = new JSDOM('<div id="app"></div>', {url:'http://localhost/a'});
  const previous = {window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
  const jobs = new Map();
  const lifecycles = [];
  let reloads = 0;
  const path = process.env.NAVIGATION_TEST_SOURCE || new URL('./PendingNavigation.tsx',import.meta.url);
  const source = readFileSync(path,'utf8');
  const output = ts.transpileModule(source,{fileName:'PendingNavigation.tsx',compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const module = {exports:{}};
  const dispatch = (name,args)=>{lifecycles.push({name,...args});return ()=>{};};
  vm.runInNewContext(output, {module,exports:module.exports,window:{location:{reload(){reloads++;}}},console,require(name){
    if(name.endsWith('preload'))return {__esModule:true,default: pathname=>new Promise((resolve,reject)=>jobs.set(pathname,{resolve,reject}))};
    if(name.endsWith('ExecutionEnvironment'))return {__esModule:true,default:{canUseDOM:true}};
    if(name.endsWith('ClientLifecyclesDispatcher'))return {__esModule:true,dispatchLifecycleAction:dispatch,default:({children,location,previousLocation})=>{React.useLayoutEffect(()=>{dispatch('onRouteDidUpdate',{location,previousLocation});},[location]);return children;}};
    if(name==='react-router-dom'||name==='@docusaurus/router')return {Route:({location})=>React.createElement('article',{'data-route':location.pathname},location.pathname)};
    return require(name);
  }});
  const Component = module.exports.default;
  const root = createRoot(dom.window.document.getElementById('app'));
  return {
    jobs,lifecycles,
    get shown(){return dom.window.document.querySelector('article')?.textContent;},
    get reloads(){return reloads;},
    async go(pathname){await act(async()=>root.render(React.createElement(Component,{location:{pathname,search:'',hash:'',state:null,key:pathname}},React.createElement('div'))));},
    async resolve(pathname){await act(async()=>{jobs.get(pathname).resolve();});},
    async reject(pathname){await act(async()=>{jobs.get(pathname).reject(new Error('stale chunk'));});},
    async close(){await act(async()=>root.unmount());dom.window.close();Object.assign(globalThis,previous);},
  };
}

test('a superseded load cannot commit a newer route before that route is ready',async()=>{
  const h=harness();
  try{
    await h.go('/a'); await h.go('/b'); await h.go('/c');
    assert.equal(h.shown,'/a');
    await h.resolve('/b');
    assert.equal(h.shown,'/a','keep the current article until the latest requested article is ready');
    await h.resolve('/c');assert.equal(h.shown,'/c');
    const commit=h.lifecycles.filter(e=>e.name==='onRouteDidUpdate').at(-1);
    assert.equal(commit.previousLocation.pathname,'/a','scroll cleanup must use the actually displayed page');
  }finally{await h.close();}
});

test('an obsolete request failure must not reload or disrupt a newer selection',async()=>{
  const h=harness();
  try{
    await h.go('/a');await h.go('/b');await h.go('/c');await h.resolve('/c');await h.reject('/b');
    assert.equal(h.shown,'/c');assert.equal(h.reloads,0);
  }finally{await h.close();}
});

test('returning to the displayed page cancels a pending article request',async()=>{
  const h=harness();
  try{
    await h.go('/a');await h.go('/b');await h.go('/a');
    if(h.jobs.has('/a'))await h.resolve('/a');
    await h.resolve('/b');assert.equal(h.shown,'/a');
  }finally{await h.close();}
});
