import express from "express";
import fetch, {Headers} from "node-fetch";
import {parseStringPromise} from "xml2js";
import child_process from "child_process";
import * as fs from "fs";
import { z } from "zod";

import config from "./config.json" assert { type: 'json' }

const app = express();
const port = 3000;

const RedditMore = z.object({
    kind: z.literal("more"),
});

type RedditMore = z.infer<typeof RedditMore>;

const RedditT1 = z.object({
    kind: z.literal("t1"),
});

type RedditT1 = z.infer<typeof RedditT1>;

const RegularPost = z.object({
    secure_media: z.object({
        reddit_video: z.object({
            dash_url: z.string(),
        })
    })
})

type RegularPost = z.infer<typeof RegularPost>;

const CrossPost = z.object({
    crosspost_parent_list: z.array(RegularPost),
})

type CrossPost = z.infer<typeof CrossPost>;

const RedditT3 = z.object({
    kind: z.literal("t3"),
    data: z.union([RegularPost, CrossPost])
});

type RedditT3 = z.infer<typeof RedditT3>;

const RedditListing = z.object({
    kind: z.literal("Listing"),
    data: z.object({
        children: z.array(z.discriminatedUnion("kind", [RedditMore, RedditT1, RedditT3]))
    })
});

type RedditListing = z.infer<typeof RedditListing>;

const DashRepresentation = z.object({
    $: z.object({
        bandwidth: z.string(),
    }),
    BaseURL: z.array(z.string())
});

type DashRepresentation = z.infer<typeof DashRepresentation>;

const DashPlaylist = z.object({
    MPD: z.object({
        Period: z.array(z.object({
            AdaptationSet: z.array(z.object({
                $: z.object({
                    contentType: z.enum(["audio", "video"]),
                }),
                Representation: z.array(DashRepresentation),
            }))
        }))
    })
});

type DashPlaylist = z.infer<typeof DashPlaylist>;

function bestRepr(reprs: DashRepresentation[]): string {
    let best: any = null;

    for (let repr of reprs) {
        if (best == null || parseInt(repr.$.bandwidth, 10) > parseInt(best.$.bandwidth, 10)) {
            best = repr;
        }
    }

    return best.BaseURL[0];
}

let alphaNumericRegex = /^[a-z0-9]+$/;

function encode(id: string, video: string, audio: string, timestamp: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
        let process = child_process.spawn("ffmpeg", [
            "-i",
            `https://v.redd.it/${id}/${video}`,
            "-i",
            `https://v.redd.it/${id}/${audio}`,
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            `/tmp/${id}_${timestamp}.mp4`,
        ]);

        process.on("close", code => {
            resolve(code);
        })

        process.on("error", err => {
            reject(err);
        })
    });
}

async function httpGet(url: string) {
    return fetch(url, {
        method: "GET",
        headers: new Headers({
            "User-Agent": config.useragent
        }),
    })
}

let idRegex = /https:\/\/v\.redd\.it\/(.*)\/DASHPlaylist\.mpd/;

app.get("/:id", async (req, res) => {
    let id = req.params.id;

    if (!id || !id.match(alphaNumericRegex)) {
        res.status(500).send("wtf");
        return;
    }

    let dashUrl = `https://v.redd.it/${id}/DASHPlaylist.mpd`;

    let dash = await (await httpGet(dashUrl)).text();

    let dashData: DashPlaylist;

    try {
        dashData = DashPlaylist.parse(await parseStringPromise(dash));
    } catch (e) {
        res.status(400).send("bad url");
        return;
    }

    let sets = dashData.MPD.Period[0].AdaptationSet;

    let audioSet = sets.find(x => x.$.contentType == "audio");
    let videoSet = sets.find(x => x.$.contentType == "video");

    if (!videoSet) {
        res.status(500).send("wtf");
        return;
    }

    let bestVideo = bestRepr(videoSet.Representation);

    if (!audioSet) {
        res.redirect(`https://v.redd.it/${id}/${bestVideo}`);
        return;
    }

    let bestAudio = bestRepr(audioSet.Representation);

    let timestamp = Date.now();

    await encode(id, bestVideo, bestAudio, timestamp);

    res.sendFile(`/tmp/${id}_${timestamp}.mp4`, () => {
        fs.unlink(`/tmp/${id}_${timestamp}.mp4`, () => {});
    });
});

app.get("/:para(*)", async (req, res) => {
    let url = `https://reddit.com/${req.params.para}`;
    let json = `${url}.json`;

    let dashUrl: string;

    let data: RedditListing[];
    try {
        data = z.array(RedditListing).parse(await (await httpGet(json)).json());
    } catch (e) {
        console.log(e);
        res.status(400).send("bad url");
        return;
    }
    if (data[0].data.children[0].kind == "t3") {
        if ('crosspost_parent_list' in data[0].data.children[0].data) {
            dashUrl = data[0].data.children[0].data.crosspost_parent_list[0].secure_media.reddit_video.dash_url;
        } else {
            dashUrl = data[0].data.children[0].data.secure_media.reddit_video.dash_url;
        }
    } else {
        res.status(500).send("wtf");
        return;
    }

    let id = dashUrl.match(idRegex)?.[1];
    if (!id || !id.match(alphaNumericRegex)) {
        res.status(500).send("wtf");
        return;
    }

    res.redirect(`${config.host}/${id}`)
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
})