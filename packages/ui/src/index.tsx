import type { ButtonHTMLAttributes } from "react";
export {useSuiteOrganization} from "./organization.tsx";
export {SuiteShell,SpaceList,SearchField,SaveState,SectionHeading,RecordGrid,ToolEntrances,Modal,useDraftNavigation,SUITE_TOOLS,type SuiteTool} from "./shell.tsx";
export function Button({className="",...props}:ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`} {...props}/>;
}
export function RecallMark() {
  return <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect width="32" height="32" rx="11" fill="#7471a2"/><path d="M11 23V9h6a5 5 0 0 1 0 10h-6m6 0 5 4" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
