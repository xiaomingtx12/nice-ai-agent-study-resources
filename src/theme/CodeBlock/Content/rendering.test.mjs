import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const require = createRequire(import.meta.url);
function render(code, language = 'javascript') {
  const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.ReactJSX, esModuleInterop:true}}).outputText;
  const module = {exports:{}};
  const metadata = {code,language,lineNumbersStart:1,lineClassNames:{0:'highlighted-line'}};
  vm.runInNewContext(output,{module,exports:module.exports,require(name){
    if(name==='@docusaurus/useIsBrowser')return {__esModule:true,default:()=>false};
    if(name==='@docusaurus/theme-common/internal')return {useCodeBlockContext:()=>({metadata,wordWrap:{codeBlockRef:{current:null}}})};
    if(name==='./tokenMarkup')return require('./tokenMarkup.ts');
    if(name.endsWith('.css'))return {codeBlock:'code-block',codeBlockLines:'code-lines'};
    if(name==='@theme/CodeBlock/Line')return {__esModule:true,default:({line,getLineProps,getTokenProps,classNames,showLineNumbers})=>React.createElement('div',{...getLineProps({line,className:classNames}),'data-numbered':showLineNumbers},line.map((token,i)=>React.createElement('span',{...getTokenProps({token}),key:i})))};
    return require(name);
  }});
  return renderToStaticMarkup(React.createElement(module.exports.default));
}

test('the first server render already contains syntax tokens and line metadata',()=>{
  const html=render('const answer = "ready";');
  assert.match(html,/token keyword/);
  assert.match(html,/token string/);
  assert.match(html,/highlighted-line/);
  assert.match(html,/site-code-line-numbered/);
  assert.doesNotMatch(html,/#EFE5D0|#2B221D|background-color:/i);
});

test('code is escaped and an unsupported language still displays its full content',()=>{
  const html=render('<script>alert("x")</script>','unknown-language');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
});
