(() => {
  "use strict";
  const reduce=matchMedia("(prefers-reduced-motion:reduce)").matches;
  const COLS=62,VIS_ROWS=12,PRINT_ROW=7,FS=19,ROWH=Math.round(FS*1.5);
  const PAD_X=22,PAD_Y=16,BELL_COL=COLS-8,FONT=`${FS}px "Courier Prime","Courier New",monospace`;

  const grid=[];const caret={x:0,y:0};const leftMargin=0;
  let bellArmed=true,strike=null,carVisX=0,scrollVis=0;
  let physShift=false,lock=false,latch=false;        // Shift
  let figHeld=false,figLatch=false;                   // FIG.
  const shiftActive=()=>physShift||lock||latch;
  const figActive=()=>figHeld||figLatch;

  const ensureRow=y=>{while(grid.length<=y)grid.push(Array.from({length:COLS},()=>[]))};
  const scrollOffset=()=>Math.max(0,caret.y-PRINT_ROW);

  // Canvas
  const cv=document.getElementById("paper"),ctx=cv.getContext("2d");
  let charW=FS*0.6,cssW=0,cssH=0;
  function layout(){
    const dpr=Math.min(devicePixelRatio||1,2);
    ctx.font=FONT;charW=ctx.measureText("M").width||FS*0.6;
    cssW=COLS*charW+PAD_X*2;cssH=VIS_ROWS*ROWH+PAD_Y*2;
    cv.style.aspectRatio=`${cssW} / ${cssH}`;
    const realW=cv.clientWidth||cssW,scale=realW/cssW;
    cv.width=Math.round(realW*dpr);cv.height=Math.round(cssH*scale*dpr);
    ctx.setTransform(dpr*scale,0,0,dpr*scale,0,0);ctx.textBaseline="alphabetic";ctx.textAlign="left";
  }
  function draw(){
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,cv.width,cv.height);ctx.restore();
    const baseTop=PAD_Y+FS,off=scrollVis;ctx.font=FONT;
    for(let y=0;y<grid.length;y++){
      const srw=y-off;if(srw<-1||srw>VIS_ROWS)continue;
      const py=baseTop+srw*ROWH,cells=grid[y];
      for(let x=0;x<COLS;x++){const st=cells[x];if(!st||!st.length)continue;const px=PAD_X+x*charW;
        for(const g of st){ctx.save();ctx.translate(px+g.jx,py+g.jy);if(g.rot)ctx.rotate(g.rot);ctx.fillStyle=`rgba(43,42,38,${g.a})`;ctx.fillText(g.ch,0,0);ctx.restore();}}
    }
    const ppX=PAD_X+carVisX*charW,ppY=baseTop+(caret.y-off)*ROWH;
    ctx.fillStyle="#c0392b";ctx.globalAlpha=.9;ctx.fillRect(ppX,ppY+4,charW,2);ctx.globalAlpha=1;
    if(strike){const t=(performance.now()-strike.t)/90;
      if(t<1){const sx=PAD_X+strike.x*charW,sy=baseTop+(strike.y-off)*ROWH;
        ctx.strokeStyle=`rgba(43,42,38,${(1-t)*.5})`;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(sx+charW/2,sy+6);ctx.lineTo(sx+charW/2,sy-FS-10*(1-t));ctx.stroke();}else strike=null;}
  }
  function frame(){const tx=caret.x,so=scrollOffset();
    if(reduce){carVisX=tx;scrollVis=so;}else{carVisX+=(tx-carVisX)*.45;scrollVis+=(so-scrollVis)*.35;
      if(Math.abs(tx-carVisX)<.01)carVisX=tx;if(Math.abs(so-scrollVis)<.01)scrollVis=so;}
    draw();requestAnimationFrame(frame);}

  // 入力動作
  function typeChar(ch){
    ensureRow(caret.y);if(caret.x>=COLS){sndLock();return;}
    grid[caret.y][caret.x].push({ch,jx:(Math.random()-.5)*1.4,jy:(Math.random()-.5)*1.4,a:.78+Math.random()*.22,rot:(Math.random()-.5)*.03});
    strike={x:caret.x,y:caret.y,t:performance.now()};sndKey();caret.x++;
    if(bellArmed&&caret.x===BELL_COL){sndBell();flashBell();bellArmed=false;}
    if(latch&&!lock&&!physShift){latch=false;setShiftVisual();}
    if(figLatch&&!figHeld){figLatch=false;setFigVisual();}
    updateStatus();
  }
  function carriageReturn(){caret.x=leftMargin;bellArmed=true;sndCR();swingLever();updateStatus();}
  function lineFeed(){caret.y+=1;ensureRow(caret.y);sndLF();spinKnob();updateStatus();}
  function backspace(){caret.x=Math.max(leftMargin,caret.x-1);sndBack();updateStatus();}

  // キーボード生成（AIR MAIL風 / FIG.方式）
  // [code, base(小文字/記号), fig(図形位置の数字・記号)]
  const LROWS=[
    [["KeyQ","q","\""],["KeyW","w","#"],["KeyE","e","$"],["KeyR","r","%"],["KeyT","t","&"],["KeyY","y","'"],["KeyU","u","("],["KeyI","i",")"],["KeyO","o","*"],["KeyP","p","+"]],
    [["KeyA","a","1"],["KeyS","s","2"],["KeyD","d","3"],["KeyF","f","4"],["KeyG","g","5"],["KeyH","h","6"],["KeyJ","j","7"],["KeyK","k","8"],["KeyL","l","9"]],
    [["KeyZ","z","0"],["KeyX","x","_"],["KeyC","c","="],["KeyV","v",":"],["KeyB","b",";"],["KeyN","n","/"],["KeyM","m","-"],["Comma",",","!"],["Period",".","?"]]
  ];
  const figMap={};LROWS.forEach(r=>r.forEach(([c,lo,f])=>figMap[c]=f));
  const kb=document.getElementById("keyboard"),keyMap=new Map(),figEls=[];
  function makeKey([code,lo,fig]){
    const up=lo.length===1&&lo>="a"&&lo<="z"?lo.toUpperCase():lo;
    const k=document.createElement("div");k.className="key";
    k.dataset.code=code;k.dataset.lo=lo;k.dataset.up=up;k.dataset.figc=fig;
    k.innerHTML=`<span class="fig">${fig}</span><b>${up}</b>`;
    keyMap.set(code,k);return k;
  }
  function makeFig(){const k=document.createElement("div");k.className="key wide figkey";k.textContent="FIG.";figEls.push(k);return k;}
  LROWS.forEach((row,i)=>{
    const r=document.createElement("div");r.className="krow";
    if(i>=1)r.appendChild(makeFig());           // 下2行の両端にFIG.（AIR MAIL配置）
    row.forEach(d=>r.appendChild(makeKey(d)));
    if(i>=1)r.appendChild(makeFig());
    kb.appendChild(r);
  });
  // 特殊行
  const sr=document.createElement("div");sr.className="krow";
  function special(code,label,cls){const k=document.createElement("div");k.className="key wide "+cls;k.dataset.code=code;k.textContent=label;sr.appendChild(k);keyMap.set(code,k);return k;}
  special("CapsLock","Shift Lock","lock");
  special("ShiftLeft","⇧ Shift","shift");
  special("Space","␣","space");
  special("ShiftRight","Shift ⇧","shift");
  special("Backspace","⌫","");
  kb.appendChild(sr);

  // クリック/タップ
  function consumeFig(){if(figLatch&&!figHeld){figLatch=false;setFigVisual();}}
  function emitKey(el){
    if(figActive()){const f=el.dataset.figc;if(f)typeChar(f);consumeFig();return;}
    typeChar(shiftActive()?el.dataset.up:el.dataset.lo);
  }
  keyMap.forEach((el,code)=>{
    el.addEventListener("pointerdown",e=>{e.preventDefault();
      if(code==="Space"){el.classList.add("pressed");typeChar(" ");return;}
      if(code==="Backspace"){el.classList.add("pressed");backspace();return;}
      if(code==="CapsLock"){lock=!lock;setShiftVisual();sndShift();return;}
      if(code==="ShiftLeft"||code==="ShiftRight"){latch=!latch;setShiftVisual();if(latch)sndShift();return;}
      el.classList.add("pressed");emitKey(el);
    });
    el.addEventListener("pointerup",()=>el.classList.remove("pressed"));
    el.addEventListener("pointerleave",()=>el.classList.remove("pressed"));
  });
  figEls.forEach(el=>{
    el.addEventListener("pointerdown",e=>{e.preventDefault();figLatch=!figLatch;setFigVisual();if(figLatch)sndFig();});
  });

  function pressVisual(code,on){const el=keyMap.get(code);if(!el)return;
    if(code==="ShiftLeft"||code==="ShiftRight"||code==="CapsLock")return;el.classList.toggle("pressed",on);}
  function setShiftVisual(){document.body.classList.toggle("shifted",shiftActive());
    const on=physShift||latch;keyMap.get("ShiftLeft").classList.toggle("held",on);keyMap.get("ShiftRight").classList.toggle("held",on);keyMap.get("CapsLock").classList.toggle("on",lock);}
  function setFigVisual(){document.body.classList.toggle("figmode",figActive());const on=figHeld||figLatch;figEls.forEach(e=>e.classList.toggle("held",on));}

  // 物理キーボード
  addEventListener("keydown",e=>{
    if(!overlay.classList.contains("hide"))return;
    if(e.code==="AltLeft"||e.code==="AltRight"){e.preventDefault();if(!figHeld){figHeld=true;setFigVisual();sndFig();}return;}
    if(e.code==="ShiftLeft"||e.code==="ShiftRight"){if(!physShift){physShift=true;setShiftVisual();sndShift();}return;}
    if(e.code==="CapsLock"){e.preventDefault();lock=!lock;setShiftVisual();sndShift();return;}
    if(e.code==="Enter"||e.code==="NumpadEnter"){e.preventDefault();
      if(e.shiftKey)carriageReturn();else if(e.ctrlKey||e.metaKey)lineFeed();else{carriageReturn();lineFeed();}return;}
    if(e.code==="Backspace"){e.preventDefault();pressVisual("Backspace",true);backspace();return;}
    if(e.code==="Space"){e.preventDefault();pressVisual("Space",true);typeChar(" ");return;}
    if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){
      e.preventDefault();
      if(figActive()){const f=figMap[e.code];if(f){pressVisual(e.code,true);typeChar(f);consumeFig();}return;}
      pressVisual(e.code,true);typeChar(e.key);     // 大小はOS解決
    }
  });
  addEventListener("keyup",e=>{
    if(e.code==="AltLeft"||e.code==="AltRight"){figHeld=false;setFigVisual();return;}
    if(e.code==="ShiftLeft"||e.code==="ShiftRight"){physShift=false;setShiftVisual();sndShiftUp();return;}
    pressVisual(e.code,false);
  });
  addEventListener("blur",()=>{physShift=false;figHeld=false;setShiftVisual();setFigVisual();keyMap.forEach(el=>el.classList.remove("pressed"));});

  // レバー / ノブ
  const leverEl=document.getElementById("leverCR"),knobBtn=document.getElementById("knobLF"),knobEl=document.getElementById("knob");
  let knobAngle=0;
  leverEl.addEventListener("click",()=>carriageReturn());
  knobBtn.addEventListener("click",()=>lineFeed());
  function swingLever(){if(reduce)return;leverEl.classList.add("swing");setTimeout(()=>leverEl.classList.remove("swing"),150);}
  function spinKnob(){if(reduce)return;knobAngle+=52;knobEl.style.transform=`rotate(${knobAngle}deg)`;}

  // ステータス
  const statusEl=document.getElementById("status"),bellDot=document.getElementById("belldot");
  function updateStatus(){statusEl.firstChild.nodeValue=`行 ${caret.y+1} · 桁 ${caret.x+1} `;}
  let bellTimer;function flashBell(){bellDot.classList.add("on");clearTimeout(bellTimer);bellTimer=setTimeout(()=>bellDot.classList.remove("on"),260);}

  // Web Audio
  let actx=null;const ac=()=>actx||(actx=new (window.AudioContext||window.webkitAudioContext)());
  function noiseBuf(d){const c=ac(),n=Math.floor(c.sampleRate*d),b=c.createBuffer(1,n,c.sampleRate),a=b.getChannelData(0);for(let i=0;i<n;i++)a[i]=Math.random()*2-1;return b;}
  function burst({dur=.04,freq=2200,q=1,type="bandpass",gain=.5,decay=null}={}){
    const c=ac(),s=c.createBufferSource();s.buffer=noiseBuf(dur);
    const f=c.createBiquadFilter();f.type=type;f.frequency.value=freq;f.Q.value=q;
    const g=c.createGain(),now=c.currentTime,d=decay??dur;
    g.gain.setValueAtTime(gain,now);g.gain.exponentialRampToValueAtTime(.0001,now+d);
    s.connect(f);f.connect(g);g.connect(c.destination);s.start();s.stop(now+d+.02);}
  function tone({freq=1000,dur=.18,gain=.25,type="sine"}={}){
    const c=ac(),o=c.createOscillator(),g=c.createGain(),now=c.currentTime;
    o.type=type;o.frequency.value=freq;g.gain.setValueAtTime(gain,now);g.gain.exponentialRampToValueAtTime(.0001,now+dur);
    o.connect(g);g.connect(c.destination);o.start();o.stop(now+dur+.02);}
  const sndKey=()=>burst({dur:.03,freq:2400,q:.8,gain:.45,decay:.05});
  const sndBack=()=>burst({dur:.03,freq:1500,q:1,gain:.3,decay:.05});
  const sndLock=()=>burst({dur:.02,freq:900,q:2,gain:.25,decay:.03});
  const sndBell=()=>{tone({freq:1050,dur:.22,gain:.22});tone({freq:1560,dur:.18,gain:.12});};
  function sndCR(){burst({dur:.16,freq:600,q:.5,type:"lowpass",gain:.3,decay:.18});setTimeout(()=>burst({dur:.04,freq:1200,q:1,gain:.4,decay:.06}),130);}
  function sndLF(){burst({dur:.025,freq:1800,q:1.5,gain:.35,decay:.03});setTimeout(()=>burst({dur:.025,freq:1400,q:1.5,gain:.28,decay:.03}),55);}
  // Shift「ガチャッ」: 低い打突 → 金属クリック
  function sndShift(){burst({dur:.05,freq:360,q:.6,type:"lowpass",gain:.4,decay:.07});setTimeout(()=>burst({dur:.03,freq:1600,q:1.4,gain:.32,decay:.04}),32);}
  function sndShiftUp(){burst({dur:.04,freq:300,q:.6,type:"lowpass",gain:.28,decay:.05});}
  function sndFig(){burst({dur:.03,freq:1300,q:1.2,gain:.3,decay:.04});}

  // 起動
  const overlay=document.getElementById("overlay");
  overlay.addEventListener("click",()=>{overlay.classList.add("hide");ac().resume&&ac().resume();layout();ensureRow(0);updateStatus();},{once:true});
  let rt;addEventListener("resize",()=>{clearTimeout(rt);rt=setTimeout(layout,120);});
  layout();if(document.fonts&&document.fonts.ready)document.fonts.ready.then(layout);
  requestAnimationFrame(frame);
})();
