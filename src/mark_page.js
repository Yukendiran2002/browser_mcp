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

let markPageStyleInjected = false;
let labels = [];

function unmarkPage() {
  for (const label of labels) {
    if (label.parentNode) {
      label.parentNode.removeChild(label);
    }
  }
  labels = [];
}

function markPage() {
  unmarkPage();

  // Inject custom scrollbar styles once
  if (!markPageStyleInjected) {
    const styleTag = document.createElement("style");
    styleTag.textContent = customCSS;
    document.head.append(styleTag);
    markPageStyleInjected = true;
  }

  const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
  const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

  // Gather all interactive elements
  let items = Array.prototype.slice
    .call(document.querySelectorAll("*"))
    .map(function (element) {
      const textualContent = element.textContent.trim().replace(/\s{2,}/g, " ");
      const elementType = element.tagName.toLowerCase();
      const ariaLabel = element.getAttribute("aria-label") || "";
      const placeholder = element.getAttribute("placeholder") || "";
      const name = element.getAttribute("name") || "";
      const id = element.id || "";
      const role = element.getAttribute("role") || "";

      const rects = [...element.getClientRects()]
        .filter((bb) => {
          const center_x = bb.left + bb.width / 2;
          const center_y = bb.top + bb.height / 2;
          const elAtCenter = document.elementFromPoint(center_x, center_y);
          return elAtCenter === element || element.contains(elAtCenter);
        })
        .map((bb) => {
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

      const area = rects.reduce((acc, rect) => acc + rect.width * rect.height, 0);

      return {
        element: element,
        include:
          element.tagName === "INPUT" ||
          element.tagName === "TEXTAREA" ||
          element.tagName === "SELECT" ||
          element.tagName === "BUTTON" ||
          element.tagName === "A" ||
          element.tagName === "IFRAME" ||
          element.tagName === "VIDEO" ||
          element.onclick != null ||
          role === "button" ||
          role === "link" ||
          role === "tab" ||
          role === "menuitem" ||
          role === "checkbox" ||
          role === "radio" ||
          role === "switch" ||
          role === "textbox" ||
          element.getAttribute("contenteditable") === "true" ||
          window.getComputedStyle(element).cursor === "pointer",
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
    .filter((item) => item.include && item.area >= 20);

  // Only keep innermost clickable items (avoid parent containers)
  items = items.filter(
    (x) => !items.some((y) => x.element.contains(y.element) && x !== y)
  );

  // Color palette for better visibility
  const colors = [
    "#FF6633", "#FFB399", "#FF33FF", "#00B3E6", "#E6B333",
    "#3366E6", "#999966", "#99FF99", "#B34D4D", "#80B300",
    "#809900", "#E6B3B3", "#6680B3", "#66991A", "#FF99E6",
    "#CCFF1A", "#FF1A66", "#E6331A", "#33FFCC", "#66994D",
  ];

  // Draw bounding boxes with index labels
  items.forEach(function (item, index) {
    item.rects.forEach((bbox) => {
      const borderColor = colors[index % colors.length];

      const overlay = document.createElement("div");
      overlay.style.outline = `2px dashed ${borderColor}`;
      overlay.style.position = "fixed";
      overlay.style.left = bbox.left + "px";
      overlay.style.top = bbox.top + "px";
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
      labels.push(overlay);
    });
  });

  // Return compact element info (token-efficient)
  return items.map((item, index) => {
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
