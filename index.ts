/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { makeRange } from "@components/PluginSettings/components";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, GuildStore, UserStore } from "@webpack/common";
import type { Channel, Embed, GuildMember, MessageAttachment, User } from "discord-types/general";

const enum ChannelTypes {
    DM = 1,
    GROUP_DM = 3
}

interface Message {
    guild_id: string,
    attachments: MessageAttachment[],
    author: User,
    channel_id: string,
    components: any[],
    content: string,
    edited_timestamp: string,
    embeds: Embed[],
    sticker_items?: Sticker[],
    flags: number,
    id: string,
    member: GuildMember,
    mention_everyone: boolean,
    mention_roles: string[],
    mentions: Mention[],
    nonce: string,
    pinned: false,
    referenced_message: any,
    timestamp: string,
    tts: boolean,
    type: number;
}

interface Mention {
    avatar: string,
    avatar_decoration_data: any,
    discriminator: string,
    global_name: string,
    id: string,
    public_flags: number,
    username: string;
}

interface Sticker {
    t: "Sticker";
    description: string;
    format_type: number;
    guild_id: string;
    id: string;
    name: string;
    tags: string;
    type: number;
}

interface Call {
    channel_id: string,
    guild_id: string,
    message_id: string,
    region: string,
    ringing: string[];
}

const MuteStore = findByPropsLazy("isSuppressEveryoneEnabled");
const XSLog = new Logger("XSOverlay");

const settings = definePluginSettings({
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore messages from bots",
        default: false
    },
    pingColor: {
        type: OptionType.STRING,
        description: "User mention color",
        default: "#7289da"
    },
    channelPingColor: {
        type: OptionType.STRING,
        description: "Channel mention color",
        default: "#8a2be2"
    },
    soundPath: {
        type: OptionType.STRING,
        description: "Notification sound (default/warning/error)",
        default: "default"
    },
    timeout: {
        type: OptionType.NUMBER,
        description: "Notif duration (secs)",
        default: 1.0,
    },
    opacity: {
        type: OptionType.SLIDER,
        description: "Notif opacity",
        default: 1,
        markers: makeRange(0, 1, 0.1)
    },
    volume: {
        type: OptionType.SLIDER,
        description: "Volume",
        default: 0.2,
        markers: makeRange(0, 1, 0.1)
    },
});

const Native = VencordNative.pluginHelpers.XsOverlay as PluginNative<typeof import("./native")>;

export default definePlugin({
    name: "XSOverlay",
    description: "Forwards discord notifications to XSOverlay, for easy viewing in VR",
    authors: [Devs.Nyako],
    tags: ["vr", "notify"],
    settings,
    flux: {
        CALL_UPDATE({ call }: { call: Call; }) {
            if (call?.ringing?.includes(UserStore.getCurrentUser().id)) {
                const channel = ChannelStore.getChannel(call.channel_id);
                sendOtherNotif("Incoming call", `${channel.name} is calling you...`);
            }
        },
        MESSAGE_CREATE({ message, optimistic }: { message: Message; optimistic: boolean; }) {
            // Apparently without this try/catch, discord's socket connection dies if any part of this errors
            try {
                if (optimistic) return;
                const channel = ChannelStore.getChannel(message.channel_id);
                if (!shouldNotify(message, channel)) return;

                const pingColor = settings.store.pingColor.replaceAll("#", "").trim();
                const channelPingColor = settings.store.channelPingColor.replaceAll("#", "").trim();
                let finalMsg = message.content;
                let titleString = "";

                if (channel.guild_id) {
                    const guild = GuildStore.getGuild(channel.guild_id);
                    titleString = `${message.author.username} (${guild.name}, #${channel.name})`;
                }


                switch (channel.type) {
                    case ChannelTypes.DM:
                        titleString = message.author.username.trim();
                        break;
                    case ChannelTypes.GROUP_DM:
                        const channelName = channel.name.trim() ?? channel.rawRecipients.map(e => e.username).join(", ");
                        titleString = `${message.author.username} (${channelName})`;
                        break;
                }

                if (message.referenced_message) {
                    titleString += " (reply)";
                }

                if (message.embeds.length > 0) {
                    finalMsg += " [embed] ";
                    if (message.content === "") {
                        finalMsg = "sent message embed(s)";
                    }
                }

                if (message.sticker_items) {
                    finalMsg += " [sticker] ";
                    if (message.content === "") {
                        finalMsg = "sent a sticker";
                    }
                }

                const images = message.attachments.filter(e =>
                    typeof e?.content_type === "string"
                    && e?.content_type.startsWith("image")
                );


                images.forEach(img => {
                    finalMsg += ` [image: ${img.filename}] `;
                });

                message.attachments.filter(a => a && !a.content_type?.startsWith("image")).forEach(a => {
                    finalMsg += ` [attachment: ${a.filename}] `;
                });

                // make mentions readable
                if (message.mentions.length > 0) {
                    finalMsg = finalMsg.replace(/<@!?(\d{17,20})>/g, (_, id) => `<color=#${pingColor}><b>@${UserStore.getUser(id)?.username || "unknown-user"}</color></b>`);
                }

                if (message.mention_roles.length > 0) {
                    for (const roleId of message.mention_roles) {
                        const role = GuildStore.getGuild(channel.guild_id).roles[roleId];
                        if (!role) continue;
                        const roleColor = role.colorString ?? `#${pingColor}`;
                        finalMsg = finalMsg.replace(`<@&${roleId}>`, `<b><color=${roleColor}>@${role.name}</color></b>`);
                    }
                }

                // make emotes and channel mentions readable
                const emoteMatches = finalMsg.match(new RegExp("(<a?:\\w+:\\d+>)", "g"));
                const channelMatches = finalMsg.match(new RegExp("<(#\\d+)>", "g"));

                if (emoteMatches) {
                    for (const eMatch of emoteMatches) {
                        finalMsg = finalMsg.replace(new RegExp(`${eMatch}`, "g"), `:${eMatch.split(":")[1]}:`);
                    }
                }

                if (channelMatches) {
                    for (const cMatch of channelMatches) {
                        let channelId = cMatch.split("<#")[1];
                        channelId = channelId.substring(0, channelId.length - 1);
                        finalMsg = finalMsg.replace(new RegExp(`${cMatch}`, "g"), `<b><color=#${channelPingColor}>#${ChannelStore.getChannel(channelId).name}</color></b>`);
                    }
                }

                sendMsgNotif(titleString, finalMsg, message);
            } catch (err) {
                XSLog.error(`Failed to catch MESSAGE_CREATE: ${err}`);
            }
        }
    }
});

function sendMsgNotif(titleString: string, content: string, message: Message) {
    fetch(`https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png?size=128`).then(response => response.arrayBuffer()).then(result => {
        const msgData = {
            messageType: 1,
            index: 0,
            timeout: settings.store.timeout,
            height: calculateHeight(cleanMessage(content)),
            opacity: settings.store.opacity,
            volume: settings.store.volume,
            audioPath: settings.store.soundPath,
            title: titleString,
            content: content,
            useBase64Icon: true,
            icon: result,
            sourceApp: "Vencord"
        };
        Native.sendToOverlay(msgData);
    });
}

function sendOtherNotif(content: string, titleString: string) {
    const msgData = {
        messageType: 1,
        index: 0,
        timeout: settings.store.timeout,
        height: calculateHeight(cleanMessage(content)),
        opacity: settings.store.opacity,
        volume: settings.store.volume,
        audioPath: settings.store.soundPath,
        title: titleString,
        content: content,
        useBase64Icon: false,
        icon: null,
        sourceApp: "Vencord"
    };
    Native.sendToOverlay(msgData);
}

function shouldNotify(message: Message, channel: Channel) {
    const currentUser = UserStore.getCurrentUser();
    if (message.author.id === currentUser.id) return false;
    if (message.author.bot && settings.store.ignoreBots) return false;
    if (MuteStore.allowAllMessages(channel) || message.mention_everyone && !MuteStore.isSuppressEveryoneEnabled(message.guild_id)) return true;

    return message.mentions.some(m => m.id === currentUser.id);
}

function calculateHeight(content: string) {
    if (content.length <= 100) return 100;
    if (content.length <= 200) return 150;
    if (content.length <= 300) return 200;
    return 250;
}

function cleanMessage(content: string) {
    return content.replace(new RegExp("<[^>]*>", "g"), "");
}