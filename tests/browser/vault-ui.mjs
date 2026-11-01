export const fixturePassphrase="browser-verification-fixture-only-2026";
export async function unlockIfNeeded(page){
 await page.waitForFunction(()=>document.querySelector(".pt-shell")||[...document.querySelectorAll("button")].some(button=>button.textContent==="解錠する"&&!button.disabled));
 if(await page.getByRole("heading",{name:"金庫を解錠",exact:true}).isVisible()){
  await page.getByLabel("専用パスフレーズ",{exact:true}).fill(fixturePassphrase);
  await page.getByRole("button",{name:"解錠する",exact:true}).click();
 }
 await page.locator(".pt-shell").waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll(".pt-tools a")].every(a=>a.getAttribute("aria-disabled")!=="true"));
}
