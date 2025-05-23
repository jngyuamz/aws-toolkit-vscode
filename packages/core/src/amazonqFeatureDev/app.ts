/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { UIMessageListener } from './views/actions/uiMessageListener'
import { ChatControllerEventEmitters, FeatureDevController } from './controllers/chat/controller'
import { AmazonQAppInitContext } from '../amazonq/apps/initContext'
import { MessagePublisher } from '../amazonq/messages/messagePublisher'
import { MessageListener } from '../amazonq/messages/messageListener'
import { fromQueryToParameters } from '../shared/utilities/uriUtils'
import { getLogger } from '../shared/logger/logger'
import { TabIdNotFoundError } from './errors'
import { featureDevChat, featureDevScheme } from './constants'
import globals from '../shared/extensionGlobals'
import { FeatureDevChatSessionStorage } from './storages/chatSession'
import { AuthUtil } from '../codewhisperer/util/authUtil'
import { debounce } from 'lodash'
import { Messenger } from '../amazonq/commons/connector/baseMessenger'
import { AppToWebViewMessageDispatcher } from '../amazonq/commons/connector/connectorMessages'

export function init(appContext: AmazonQAppInitContext) {
    const featureDevChatControllerEventEmitters: ChatControllerEventEmitters = {
        processHumanChatMessage: new vscode.EventEmitter<any>(),
        followUpClicked: new vscode.EventEmitter<any>(),
        openDiff: new vscode.EventEmitter<any>(),
        processChatItemVotedMessage: new vscode.EventEmitter<any>(),
        processChatItemFeedbackMessage: new vscode.EventEmitter<any>(),
        stopResponse: new vscode.EventEmitter<any>(),
        tabOpened: new vscode.EventEmitter<any>(),
        tabClosed: new vscode.EventEmitter<any>(),
        authClicked: new vscode.EventEmitter<any>(),
        processResponseBodyLinkClick: new vscode.EventEmitter<any>(),
        insertCodeAtPositionClicked: new vscode.EventEmitter<any>(),
        fileClicked: new vscode.EventEmitter<any>(),
        storeCodeResultMessageId: new vscode.EventEmitter<any>(),
    }

    const messenger = new Messenger(
        new AppToWebViewMessageDispatcher(appContext.getAppsToWebViewMessagePublisher()),
        featureDevChat
    )
    const sessionStorage = new FeatureDevChatSessionStorage(messenger)

    new FeatureDevController(
        featureDevChatControllerEventEmitters,
        messenger,
        sessionStorage,
        appContext.onDidChangeAmazonQVisibility.event
    )

    const featureDevProvider = new (class implements vscode.TextDocumentContentProvider {
        async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
            const params = fromQueryToParameters(uri.query)

            const tabID = params.get('tabID')
            if (!tabID) {
                getLogger().error(`Unable to find tabID from ${uri.toString()}`)
                throw new TabIdNotFoundError()
            }

            const session = await sessionStorage.getSession(tabID)
            const content = await session.config.fs.readFile(uri)
            const decodedContent = new TextDecoder().decode(content)
            return decodedContent
        }
    })()

    const textDocumentProvider = vscode.workspace.registerTextDocumentContentProvider(
        featureDevScheme,
        featureDevProvider
    )

    globals.context.subscriptions.push(textDocumentProvider)

    const featureDevChatUIInputEventEmitter = new vscode.EventEmitter<any>()

    new UIMessageListener({
        chatControllerEventEmitters: featureDevChatControllerEventEmitters,
        webViewMessageListener: new MessageListener<any>(featureDevChatUIInputEventEmitter),
    })

    appContext.registerWebViewToAppMessagePublisher(
        new MessagePublisher<any>(featureDevChatUIInputEventEmitter),
        'featuredev'
    )

    const debouncedEvent = debounce(async () => {
        const authenticated = (await AuthUtil.instance.getChatAuthState()).amazonQ === 'connected'
        let authenticatingSessionIDs: string[] = []
        if (authenticated) {
            const authenticatingSessions = sessionStorage.getAuthenticatingSessions()

            authenticatingSessionIDs = authenticatingSessions.map((session) => session.tabID)

            // We've already authenticated these sessions
            for (const session of authenticatingSessions) {
                session.isAuthenticating = false
            }
        }

        messenger.sendAuthenticationUpdate(authenticated, authenticatingSessionIDs)
    }, 500)

    AuthUtil.instance.secondaryAuth.onDidChangeActiveConnection(() => {
        return debouncedEvent()
    })
    AuthUtil.instance.regionProfileManager.onDidChangeRegionProfile(() => {
        return debouncedEvent()
    })
}
