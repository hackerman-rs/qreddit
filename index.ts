import express from "express";
import fetch from "node-fetch";
import {parseStringPromise} from "xml2js";
import child_process from "child_process";
import * as fs from "fs";
import { z } from "zod";

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

const RedditT3 = z.object({
    kind: z.literal("t3"),
    data: z.object({
        secure_media: z.object({
            reddit_video: z.object({
                dash_url: z.string(),
            })
        })
    })
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

let idRegex = /https:\/\/v\.redd\.it\/(.*)\/DASHPlaylist\.mpd/;

let urlMap: {[key: string]: string} = {};

app.get("/:id", async (req, res) => {
    let id = req.params.id;

    if (!id || !id.match(alphaNumericRegex)) {
        res.status(500).send("wtf");
        return;
    }

    let dashUrl = `https://v.redd.it/${id}/DASHPlaylist.mpd`;

    let dash = await (await fetch(dashUrl)).text();

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

    if (urlMap[url]) {
        dashUrl = urlMap[url];
    } else {
        console.log(json);
        let data: RedditListing[];
        try {
            data = z.array(RedditListing).parse(await (await fetch(json)).json());
        } catch (e) {
            console.log(e);
            res.status(400).send("bad url");
            return;
        }
        if (data[0].data.children[0].kind == "t3") {
            dashUrl = data[0].data.children[0].data.secure_media.reddit_video.dash_url;
            urlMap[url] = dashUrl;
        } else {
            res.status(500).send("wtf");
            return;
        }
    }

    let id = dashUrl.match(idRegex)?.[1];
    if (!id || !id.match(alphaNumericRegex)) {
        res.status(500).send("wtf");
        return;
    }

    res.redirect(`https://v.penple.dev/${id}`)
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
})