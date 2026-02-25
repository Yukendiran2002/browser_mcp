/**
 * mark_page.js
 * 
 * Annotates interactive elements on the page with numbered bounding boxes.
 * This allows AI agents to reference elements by index instead of parsing
 * full HTML — saving significant tokens.
 * 
 * Inspired by: https://github.com/DonGuillotine/langraph_browser_agent
 */

const customCSS = `
  ::-webkit-scrollbar { width: 10px; }
  ::-webkit-scrollbar-track { background: #27272a; }
  ::-webkit-scrollbar-thumb { background: #888; border-radius: 0.375rem; }
  ::-webkit-scrollbar-thumb:hover { background: #555; }
`;

// ─── State stored on window so it persists across page.evaluate() calls ───
if (!window.__mp) {
  window.__mp = { labels: [], styleInjected: false };
}

function unmarkPage() {
  const state = window.__mp;
  // Remove all annotation overlays
  for (const el of state.labels) {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }
  state.labels = [];
  // Also remove by class as a fallback (in case labels array got out of sync)
  document.querySelectorAll('[data-mp-annotation]').forEach(function(el) {
    el.parentNode.removeChild(el);
  });
}

function markPage() {
  unmarkPage();

  const state = window.__mp;

  // Inject custom scrollbar styles once
  if (!state.styleInjected) {
    const styleTag = document.createElement("style");
    styleTag.textContent = customCSS;
    document.head.append(styleTag);
    state.styleInjected = true;
  }

  const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
  const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;

  // Gather interactive elements currently in viewport
  let items = Array.prototype.slice
    .call(document.querySelectorAll(
      'a, button, input, textarea, select, iframe, video, ' +
      '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
      '[role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], ' +
      '[contenteditable="true"], [onclick]'
    ))
    .map(function (element) {
      const textualContent = element.textContent.trim().replace(/\s{2,}/g, " ");
      const elementType = element.tagName.toLowerCase();
      const ariaLabel = element.getAttribute("aria-label") || "";
      const placeholder = element.getAttribute("placeholder") || "";
      const name = element.getAttribute("name") || "";
      const id = element.id || "";
      const role = element.getAttribute("role") || "";

      const rects = [...element.getClientRects()]
        .filter(function(bb) {
          const center_x = bb.left + bb.width / 2;
          const center_y = bb.top + bb.height / 2;
          // Only include elements visible in viewport
          if (center_x < 0 || center_x > vw || center_y < 0 || center_y > vh) return false;
          const elAtCenter = document.elementFromPoint(center_x, center_y);
          return elAtCenter === element || element.contains(elAtCenter);
        })
        .map(function(bb) {
          const rect = {
            left: Math.max(0, bb.left),
            top: Math.max(0, bb.top),
            right: Math.min(vw, bb.right),
            bottom: Math.min(vh, bb.bottom),
          };
          return {
            ...rect,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
          };
        });

      const area = rects.reduce(function(acc, rect) { return acc + rect.width * rect.height; }, 0);

      return {
        element: element,
        include: area >= 20,
        area,
        rects,
        text: textualContent.slice(0, 200),
        type: elementType,
        ariaLabel,
        placeholder,
        name,
        id,
        role,
      };
    })
    .filter(function(item) { return item.include; });

  // Also find cursor:pointer elements (but limit search to visible ones for speed)
  const pointerItems = [];
  const treeWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = treeWalker.nextNode())) {
    const el = node;
    // Skip elements we already captured
    if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.onclick ||
        el.getAttribute('role') || el.getAttribute('contenteditable')) continue;
    
    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) continue;
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    
    try {
      if (window.getComputedStyle(el).cursor === 'pointer') {
        const rects = [{
          left: Math.max(0, rect.left),
          top: Math.max(0, rect.top),
          right: Math.min(vw, rect.right),
          bottom: Math.min(vh, rect.bottom),
          width: Math.min(vw, rect.right) - Math.max(0, rect.left),
          height: Math.min(vh, rect.bottom) - Math.max(0, rect.top),
        }];
        const area = rects[0].width * rects[0].height;
        if (area >= 20) {
          pointerItems.push({
            element: el,
            include: true,
            area,
            rects,
            text: el.textContent.trim().replace(/\s{2,}/g, " ").slice(0, 200),
            type: el.tagName.toLowerCase(),
            ariaLabel: el.getAttribute("aria-label") || "",
            placeholder: el.getAttribute("placeholder") || "",
            name: el.getAttribute("name") || "",
            id: el.id || "",
            role: el.getAttribute("role") || "",
          });
        }
      }
    } catch (e) {}
  }
  items = items.concat(pointerItems);

  // Only keep innermost clickable items (avoid parent containers)
  items = items.filter(
    function(x) { return !items.some(function(y) { return x.element.contains(y.element) && x !== y; }); }
  );

  // Color palette
  const colors = [
    "#FF6633", "#FFB399", "#FF33FF", "#00B3E6", "#E6B333",
    "#3366E6", "#999966", "#99FF99", "#B34D4D", "#80B300",
    "#809900", "#E6B3B3", "#6680B3", "#66991A", "#FF99E6",
    "#CCFF1A", "#FF1A66", "#E6331A", "#33FFCC", "#66994D",
  ];

  // Draw annotations with absolute positioning (scrolls naturally with page)
  items.forEach(function (item, index) {
    item.rects.forEach(function(bbox) {
      const borderColor = colors[index % colors.length];

      const overlay = document.createElement("div");
      overlay.setAttribute("data-mp-annotation", "true");
      overlay.style.outline = "2px dashed " + borderColor;
      overlay.style.position = "absolute";
      overlay.style.left = (bbox.left + scrollX) + "px";
      overlay.style.top = (bbox.top + scrollY) + "px";
      overlay.style.width = bbox.width + "px";
      overlay.style.height = bbox.height + "px";
      overlay.style.pointerEvents = "none";
      overlay.style.boxSizing = "border-box";
      overlay.style.zIndex = "2147483647";

      const label = document.createElement("span");
      label.textContent = index;
      label.style.position = "absolute";
      label.style.top = "-19px";
      label.style.left = "0px";
      label.style.background = borderColor;
      label.style.color = "white";
      label.style.padding = "2px 6px";
      label.style.fontSize = "12px";
      label.style.fontWeight = "bold";
      label.style.fontFamily = "monospace";
      label.style.borderRadius = "2px";
      label.style.whiteSpace = "nowrap";

      overlay.appendChild(label);
      document.body.appendChild(overlay);
      state.labels.push(overlay);
    });
  });

  // Return compact element info
  return items.map(function(item, index) {
    const bbox = item.rects[0] || { left: 0, top: 0, width: 0, height: 0 };
    return {
      index,
      type: item.type,
      text: item.text.slice(0, 80),
      ariaLabel: item.ariaLabel,
      placeholder: item.placeholder,
      name: item.name,
      id: item.id,
      role: item.role,
      x: Math.round(bbox.left + bbox.width / 2),
      y: Math.round(bbox.top + bbox.height / 2),
    };
  });
}
