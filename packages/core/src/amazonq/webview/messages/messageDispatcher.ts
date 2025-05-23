/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Webview, Uri } from 'vscode'
import { MessagePublisher } from '../../messages/messagePublisher'
import { MessageListener } from '../../messages/messageListener'
import { TabType } from '../ui/storages/tabsStorage'
import { getLogger } from '../../../shared/logger/logger'
import { amazonqMark } from '../../../shared/performance/marks'
import { telemetry } from '../../../shared/telemetry/telemetry'
import { AmazonQChatMessageDuration } from '../../messages/chatMessageDuration'
import { isClickTelemetry, isOpenAgentTelemetry } from '../ui/telemetry/actions'
import globals from '../../../shared/extensionGlobals'
import { openUrl } from '../../../shared/utilities/vsCodeUtils'
import { DefaultAmazonQAppInitContext } from '../../apps/initContext'
import { AmazonQPromptSettings } from '../../../shared/settings'

const qChatModuleName = 'amazonqChat'

export function dispatchWebViewMessagesToApps(
    webview: Webview,
    webViewToAppsMessagePublishers: Map<TabType, MessagePublisher<any>>
) {
    webview.onDidReceiveMessage((msg) => {
        handleWebviewEvent(msg, webViewToAppsMessagePublishers)
    })
}

export function isLegacyEvent(value: string): boolean {
    return (
        value === 'ui-is-ready' ||
        value === 'start-chat-message-telemetry' ||
        value === 'update-chat-message-telemetry' ||
        value === 'stop-chat-message-telemetry' ||
        value === 'open-link' ||
        value === 'send-telemetry' ||
        value === 'disclaimer-acknowledged' ||
        value === 'update-welcome-count'
    )
}

export function handleWebviewEvent(msg: any, webViewToAppsMessagePublishers: Map<TabType, MessagePublisher<any>>) {
    switch (msg.command) {
        case 'ui-is-ready': {
            DefaultAmazonQAppInitContext.instance.getAppsToWebViewMessagePublisher().setUiReady()
            /**
             * ui-is-ready isn't associated to any tab so just record the telemetry event and continue.
             * This would be equivalent of the duration between "user clicked open q" and "ui has become available"
             * NOTE: Amazon Q UI is only loaded ONCE. The state is saved between each hide/show of the webview.
             */
            telemetry.toolkit_didLoadModule.emit({
                module: qChatModuleName,
                duration: performance.measure(amazonqMark.uiReady, amazonqMark.open).duration,
                result: 'Succeeded',
            })
            performance.clearMarks(amazonqMark.uiReady)
            performance.clearMarks(amazonqMark.open)
            // let cwcController know the ui is ready
            webViewToAppsMessagePublishers.get('cwc')?.publish(msg)
            return
        }
        case 'start-chat-message-telemetry': {
            AmazonQChatMessageDuration.startChatMessageTelemetry(msg)
            return
        }
        case 'update-chat-message-telemetry': {
            AmazonQChatMessageDuration.updateChatMessageTelemetry(msg)
            return
        }
        case 'stop-chat-message-telemetry': {
            AmazonQChatMessageDuration.stopChatMessageTelemetry(msg)
            return
        }
        case 'open-link': {
            const { link } = msg
            void openUrl(Uri.parse(link))
            return
        }
        case 'send-telemetry': {
            if (isOpenAgentTelemetry(msg)) {
                telemetry.toolkit_didLoadModule.emit({
                    module: msg.module,
                    source: msg.trigger,
                    result: 'Succeeded',
                })
                return
            } else if (isClickTelemetry(msg)) {
                telemetry.ui_click.emit({
                    elementId: msg.source,
                    result: 'Succeeded',
                })
                return
            }
            return
        }
        case 'disclaimer-acknowledged': {
            void AmazonQPromptSettings.instance.update('amazonQChatDisclaimer', true)
            return
        }
        case 'update-welcome-count': {
            const currentLoadCount = globals.globalState.tryGet('aws.amazonq.welcomeChatShowCount', Number, 0)
            void globals.globalState.tryUpdate('aws.amazonq.welcomeChatShowCount', currentLoadCount + 1)
            return
        }
    }

    if (msg.type === 'error') {
        if (msg.event === 'toolkit_didLoadModule') {
            telemetry.toolkit_didLoadModule.emit({
                module: qChatModuleName,
                result: 'Failed',
                reasonDesc: msg.errorMessage,
            })
        } else {
            telemetry.webview_error.emit({
                webviewName: qChatModuleName,
                result: 'Failed',
                reasonDesc: msg.errorMessage,
            })
        }
        return
    }

    const appMessagePublisher = webViewToAppsMessagePublishers.get(msg.tabType)
    if (appMessagePublisher === undefined) {
        return
    }
    appMessagePublisher.publish(msg)
}

export function dispatchAppsMessagesToWebView(webView: Webview, appsMessageListener: MessageListener<any>) {
    appsMessageListener.onMessage((msg) => {
        webView.postMessage(JSON.stringify(msg)).then(undefined, (e) => {
            getLogger().error('webView.postMessage failed: %s', (e as Error).message)
        })
    })
}
