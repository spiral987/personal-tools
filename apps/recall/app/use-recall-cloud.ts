"use client";
import {usePersonalToolsCloud,type CloudCallbacks} from "@personal-tools/auth/react";
export function useRecallCloud(callbacks:CloudCallbacks<"recall">){return usePersonalToolsCloud(callbacks,{app:"recall"});}
