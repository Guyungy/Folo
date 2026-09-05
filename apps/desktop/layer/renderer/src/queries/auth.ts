import { IN_ELECTRON } from "@follow/shared/constants"
import { useWhoami, whoamiQueryKey } from "@follow/store/user/hooks"
import { userSyncService } from "@follow/store/user/store"
import { tracker } from "@follow/tracker"
import { clearStorage } from "@follow/utils/ns"
import type { FetchError } from "ofetch"

import { setLoginModalShow } from "~/atoms/user"
import { QUERY_PERSIST_KEY } from "~/constants"
import { useAuthQuery } from "~/hooks/common"
import { deleteUserCustom as deleteUserFn, getAccountInfo, signOut as signOutFn } from "~/lib/auth"
import { ipcServices } from "~/lib/client"
import { clearAuthSessionToken, getAuthSessionToken } from "~/lib/client-session"
import { defineQuery } from "~/lib/defineQuery"
import { clearLocalPersistStoreData } from "~/store/utils/clear"

const isElectronRuntime = () => {
  return IN_ELECTRON || (typeof window !== "undefined" && !!window.electron)
}

export const auth = {
  getSession: () => defineQuery(whoamiQueryKey, () => userSyncService.whoami()),
  getAccounts: () => defineQuery(["auth", "accounts"], () => getAccountInfo()),
}

export const useAccounts = () => {
  return useAuthQuery(auth.getAccounts())
}

export const useSocialAccounts = () => {
  const accounts = useAccounts()
  return {
    ...accounts,
    data: accounts.data?.data?.filter((account) => account.provider !== "credential"),
  }
}

export const useHasPassword = () => {
  const accounts = useAccounts()
  return {
    ...accounts,
    data: !!accounts.data?.data?.find((account) => account.provider === "credential"),
  }
}

export const useSession = (options?: { enabled?: boolean }) => {
  const whoami = useWhoami()
  const { data, isLoading, ...rest } = useAuthQuery(auth.getSession(), {
    retry(failureCount, error) {
      const fetchError = error as FetchError

      if (fetchError.statusCode === undefined) {
        return false
      }

      return !!(3 - failureCount)
    },
    enabled: options?.enabled ?? true,
    refetchOnMount: true,
    staleTime: 0,
    meta: {
      persist: true,
    },
  })
  const { error } = rest
  const fetchError = error as FetchError
  const hasLocalAuthCredential = isElectronRuntime()
  const session =
    (data === undefined || (data === null && hasLocalAuthCredential)) && whoami
      ? ({ user: whoami } as NonNullable<typeof data>)
      : data

  const getAuthStatus = ():
    "loading" | "authenticated" | "error" | "unauthenticated" | "unknown" => {
    if (session) {
      return "authenticated"
    }

    if (fetchError) {
      return "error"
    }

    if (isLoading) {
      return "loading"
    }

    if (data === null) {
      return "unauthenticated"
    }

    return "unknown"
  }

  return {
    session,
    ...rest,
    status: getAuthStatus(),
  } as const
}

export const useAuthSessionCookieRefresh = (_enabled: boolean) => {}

export const handleSessionChanges = () => {
  setLoginModalShow(false)
  localStorage.removeItem(QUERY_PERSIST_KEY)
  const authSessionToken = getAuthSessionToken()
  ipcServices?.auth.sessionChanged(authSessionToken ?? undefined)
  window.location.reload()
}

export const signOut = async () => {
  const authSessionToken = getAuthSessionToken()

  try {
    if (IN_ELECTRON) {
      const authService = ipcServices?.auth as
        | ({ signOutRemote?: (token?: string) => Promise<void> } & NonNullable<
            typeof ipcServices
          >["auth"])
        | undefined
      await Promise.allSettled([
        ipcServices?.auth.signOut(),
        authService?.signOutRemote?.(authSessionToken ?? undefined),
      ])
    } else {
      await ipcServices?.auth.signOut()
      await signOutFn()
    }
  } finally {
    clearAuthSessionToken()
    // Clear query cache
    localStorage.removeItem(QUERY_PERSIST_KEY)

    // clear local store data
    await clearLocalPersistStoreData()

    // Clear local storage
    clearStorage()
    // Sign out
    await tracker.manager.clear()
  }

  window.location.reload()
}

export const deleteUser = async ({ TOTPCode }: { TOTPCode?: string }) => {
  if (!TOTPCode) {
    return
  }
  await deleteUserFn({
    TOTPCode,
  })
  await signOut()
}
