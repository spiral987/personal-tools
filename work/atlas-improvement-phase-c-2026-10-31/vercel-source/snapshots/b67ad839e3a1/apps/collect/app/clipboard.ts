/** Browser clipboard entries may expose the same file in both lists. */
export function clipboardImage(data:Pick<DataTransfer,"items"|"files">):File|null{
  const items=Array.from(data.items).filter(item=>item.kind==="file"&&item.type.startsWith("image/"));
  const files=items.length?items.map(item=>item.getAsFile()).filter((file):file is File=>file!==null):Array.from(data.files).filter(file=>file.type.startsWith("image/"));
  if(files.length>1)throw new Error("画像は1枚ずつ貼り付けてください。");
  return files[0]??null;
}
