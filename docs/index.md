---
sidebar_position: 1
title: Nice AI 学习沉淀
hide_title: true
description: 把优秀学习资源和真实开源项目，变成人能复用、AI 能调用的工程判断。能交给 AI 做的交给 AI，方向和判断留在人手里。
---

import SiteStats, {SiteCount} from '@site/src/components/SiteStats';

<section className="home-hero">
  <p className="home-hero-kicker">NICE AI · 学习沉淀档案</p>
  <h1>把优秀学习资源和真实开源项目，变成可复用的工程判断。</h1>
   <p className="home-hero-lead">在这里记录AI知识，下次直接用。遇到的问题，这里面有了之后后面可以直接解决，不用再重复造轮子。</p>
  <SiteStats />
</section>

## 三栏各做什么，从哪进

<section className="home-flow">
  <div className="home-flow-node">
    <h3><span className="home-flow-no">R</span>资源导航</h3>
    <p>值得反复回看的学习资源，人来筛；拆解或复盘卡住时，按需回来补认知。</p>
    <p className="home-flow-meta"><a href="./resources/"><SiteCount stat="resources" /> 条收录 · 进入 →</a></p>
    <p className="home-flow-tag">—— 按需调用</p>
  </div>
  <div className="home-flow-arrow"><span>────→</span><em>卡住时补认知</em></div>
  <div className="home-flow-node">
    <h3><span className="home-flow-no">A</span>应用拆解</h3>
    <p>先由人判断值得拆哪一点——工程实现、功能交互还是商业模式——AI 沿方向完成检索、通读和初稿，人验真伪定稿。</p>
    <p className="home-flow-meta"><a href="./application-notes/"><SiteCount stat="applicationNotes" /> 篇拆解 · 进入 →</a></p>
    <p className="home-flow-tag">—— 人定方向 · 广度归 AI</p>
  </div>
  <div className="home-flow-arrow"><span>────→</span><em>拆完抽技巧</em></div>
  <div className="home-flow-node">
    <h3><span className="home-flow-no">M</span>方法与复盘</h3>
    <p>从应用拆解里提炼能带到下一次的判断和 agent 工程技巧——人能复用，AI 能调用。</p>
    <p className="home-flow-meta"><a href="./notes/"><SiteCount stat="notes" /> 篇复盘 · 进入 →</a></p>
    <p className="home-flow-tag home-flow-tag-pending">—— 目标：沉成 skill（未通）</p>
  </div>
</section>

## 这个站怎么写

<section className="home-principles">
  <ul>
    <li><strong>人定方向、AI 做广度、人验真伪。</strong>AI 是学习的杠杆：检索、通读、初稿交给它，方向和判断留在人手里；每个项目先判断值得拆哪一点，不套万能模板。</li>
    <li><strong>判断必须落到行动。</strong>哪些照搬、哪些换实现、哪些别碰、什么时候不适用；每篇至少给出三处 README 里读不到的东西，不把源码翻成大白话。</li>
    <li><strong>产物为复用而结构化。</strong>人能读懂，AI 能抽取、能调用；沉淀的判断和技巧回喂 AI，让下一轮拆解更准——skill 和工作流这条回线还在建。</li>
  </ul>
</section>
