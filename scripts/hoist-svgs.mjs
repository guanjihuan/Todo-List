import { readFileSync, writeFileSync } from 'node:fs';
const path = 'src/ui/task-list.js';
let content = readFileSync(path, 'utf8');

// 1. Replace inline starSvg template literal with hoisted function call
const starPattern = /const starSvg = `<svg viewBox="0 0 24 24"[^`]*<\/svg>`;/;
const oldStar = content.match(starPattern);
console.log('Found starSvg:', !!oldStar);
content = content.replace(starPattern, 'const starSvg = starSvgFor(task.important);');

// 2. Replace inline currentSvg template literal with hoisted function call
const currentPattern = /const currentSvg = `<svg viewBox="0 0 24 24"[^`]*<\/svg>`;/;
const oldCurrent = content.match(currentPattern);
console.log('Found currentSvg:', !!oldCurrent);
content = content.replace(currentPattern, 'const currentSvg = currentSvgFor(task.current);');

// 3. Replace editPencilSvg + restoreSvg in trash block (note: order is restoreSvg first in code, editPencilSvg after)
const trashPattern = /const restoreSvg = `<svg viewBox="0 0 24 24"[^`]*<\/svg>`;\s*\n\s*const editPencilSvg = `<svg viewBox="0 0 24 24"[^`]*<\/svg>`;/;
const oldTrash = content.match(trashPattern);
console.log('Found trash pattern:', !!oldTrash);
content = content.replace(trashPattern, 'const restoreSvg = RESTORE_SVG;');

// 4. Replace editPencilSvg + deleteXSvg in normal block
const normalPattern = /const editPencilSvg = `<svg viewBox="0 0 24 24"[^`]*<\/svg>`;\s*\n\s*const deleteXSvg = `<svg viewBox="0 0 24 24"[^`]*<\/svg>`;/;
const oldNormal = content.match(normalPattern);
console.log('Found normal pattern:', !!oldNormal);
content = content.replace(normalPattern, 'const deleteXSvg = DELETE_X_SVG;');

// 5. Also need to handle editPencilSvg in trash — there's still a leftover const editPencilSvg to replace
const lonelyEditPattern = /const editPencilSvg = `<svg viewBox="0 0 24 24"[^`]*<\/svg>`;/;
const lonelyEdit = content.match(lonelyEditPattern);
console.log('Found lonely editPencilSvg:', !!lonelyEdit);
content = content.replace(lonelyEditPattern, 'const editPencilSvg = EDIT_PENCIL_SVG;');

writeFileSync(path, content);
console.log('Done. File length:', content.length);