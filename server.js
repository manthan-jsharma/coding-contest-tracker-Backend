import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import cron from "node-cron";
import dotenv from "dotenv";
import axios from "axios";
import cheerio from "cheerio";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected successfully"))
  .catch((err) => console.error("MongoDB connection error:", err));

const contestSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    platform: {
      type: String,
      required: true,
      enum: ["codeforces", "codechef", "leetcode"],
    },
    startTime: { type: Date, required: true },
    endTime: { type: Date },
    duration: { type: Number }, // in seconds
  },
  { timestamps: true }
);

const Contest = mongoose.model("Contest", contestSchema);

// User Schema for bookmarks
const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    bookmarkedContests: [{ type: String }], // Array of contest IDs
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);

// API Routes
app.get("/api/contests", async (req, res) => {
  try {
    const contests = await Contest.find().sort({ startTime: 1 });
    res.json(contests);
  } catch (error) {
    console.error("Error fetching contests:", error);
    res.status(500).json({ error: "Failed to fetch contests" });
  }
});

// Get contests by platform
app.get("/api/contests/:platform", async (req, res) => {
  try {
    const { platform } = req.params;
    if (!["codeforces", "codechef", "leetcode"].includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }

    const contests = await Contest.find({ platform }).sort({ startTime: 1 });
    res.json(contests);
  } catch (error) {
    console.error(`Error fetching ${req.params.platform} contests:`, error);
    res.status(500).json({ error: "Failed to fetch contests" });
  }
});

// Fetch Codeforces contests
async function fetchCodeforcesContests() {
  try {
    console.log("Fetching Codeforces contests...");
    const response = await axios.get("https://codeforces.com/api/contest.list");
    const data = response.data;

    if (data.status === "OK") {
      return data.result.map((contest) => {
        const startTimeMs = contest.startTimeSeconds * 1000;
        const durationSeconds = contest.durationSeconds;

        return {
          id: `cf-${contest.id}`,
          name: contest.name,
          url: `https://codeforces.com/contest/${contest.id}`,
          platform: "codeforces",
          startTime: new Date(startTimeMs),
          duration: durationSeconds,
          endTime: new Date(startTimeMs + durationSeconds * 1000),
        };
      });
    }
    return [];
  } catch (error) {
    console.error("Error fetching Codeforces contests:", error);
    return [];
  }
}

// Fetch CodeChef contests
async function fetchCodeChefContests() {
  try {
    console.log("Fetching CodeChef contests...");
    const response = await axios.get(
      "https://www.codechef.com/api/list/contests/all?sort_by=START&sorting_order=asc&offset=0&mode=all"
    );
    const data = response.data;

    if (data.status === "success") {
      const contests = [];

      // Process future contests
      for (const contest of data.future_contests) {
        const startTime = new Date(contest.contest_start_date_iso);
        const endTime = new Date(contest.contest_end_date_iso);
        const duration = (endTime - startTime) / 1000; // Convert to seconds

        contests.push({
          id: `cc-${contest.contest_code}`,
          name: contest.contest_name,
          url: `https://www.codechef.com/${contest.contest_code}`,
          platform: "codechef",
          startTime,
          endTime,
          duration,
        });
      }

      // Process present contests
      for (const contest of data.present_contests) {
        const startTime = new Date(contest.contest_start_date_iso);
        const endTime = new Date(contest.contest_end_date_iso);
        const duration = (endTime - startTime) / 1000; // Convert to seconds

        contests.push({
          id: `cc-${contest.contest_code}`,
          name: contest.contest_name,
          url: `https://www.codechef.com/${contest.contest_code}`,
          platform: "codechef",
          startTime,
          endTime,
          duration,
        });
      }

      // Process past contests (limit to recent ones)
      for (const contest of data.past_contests.slice(0, 10)) {
        const startTime = new Date(contest.contest_start_date_iso);
        const endTime = new Date(contest.contest_end_date_iso);
        const duration = (endTime - startTime) / 1000; // Convert to seconds

        contests.push({
          id: `cc-${contest.contest_code}`,
          name: contest.contest_name,
          url: `https://www.codechef.com/${contest.contest_code}`,
          platform: "codechef",
          startTime,
          endTime,
          duration,
        });
      }

      return contests;
    }
    return [];
  } catch (error) {
    console.error("Error fetching CodeChef contests:", error);
    return [];
  }
}

// Fetch LeetCode contests
async function fetchLeetCodeContests() {
  try {
    console.log("Fetching LeetCode contests...");
    // LeetCode doesn't have a public API for contests, so we'll use web scraping
    const response = await axios.get("https://leetcode.com/contest/");
    const $ = cheerio.load(response.data);

    const contests = [];

    // Process upcoming contests
    $(".contest-card").each((i, element) => {
      const name = $(element).find(".contest-title").text().trim();
      const timeText = $(element).find(".contest-time-info").text().trim();

      // Extract start time
      const startTimeMatch = timeText.match(/Starts: (.*?)(?:Ends|$)/s);
      if (startTimeMatch && startTimeMatch[1]) {
        const startTimeStr = startTimeMatch[1].trim();
        const startTime = new Date(startTimeStr);

        // Extract end time
        const endTimeMatch = timeText.match(/Ends: (.*?)$/s);
        let endTime;
        if (endTimeMatch && endTimeMatch[1]) {
          const endTimeStr = endTimeMatch[1].trim();
          endTime = new Date(endTimeStr);
        } else {
          // LeetCode contests are typically 1.5 or 2 hours
          endTime = new Date(startTime.getTime() + 90 * 60 * 1000); // Default to 90 minutes
        }

        const duration = (endTime - startTime) / 1000; // Convert to seconds

        // Generate a unique ID based on name and start time
        const contestId = `lc-${name
          .toLowerCase()
          .replace(/\s+/g, "-")}-${startTime.getTime()}`;

        contests.push({
          id: contestId,
          name,
          url: "https://leetcode.com/contest/",
          platform: "leetcode",
          startTime,
          endTime,
          duration,
        });
      }
    });

    // Also try to fetch from the contest API endpoint
    try {
      const graphqlResponse = await axios.post("https://leetcode.com/graphql", {
        query: `
          query getContestList {
            allContests {
              title
              titleSlug
              startTime
              duration
              description
            }
            currentContests: allContests(status: Active) {
              title
              titleSlug
              startTime
              duration
            }
            pastContests: allContests(status: Past) {
              title
              titleSlug
              startTime
              duration
            }
          }
        `,
      });

      if (graphqlResponse.data && graphqlResponse.data.data) {
        const allContests = [
          ...(graphqlResponse.data.data.currentContests || []),
          ...(graphqlResponse.data.data.pastContests || []).slice(0, 5), // Limit past contests
        ];

        for (const contest of allContests) {
          const startTime = new Date(contest.startTime * 1000); // Convert from Unix timestamp
          const duration = contest.duration; // In seconds
          const endTime = new Date(startTime.getTime() + duration * 1000);

          contests.push({
            id: `lc-${contest.titleSlug}`,
            name: contest.title,
            url: `https://leetcode.com/contest/${contest.titleSlug}`,
            platform: "leetcode",
            startTime,
            endTime,
            duration,
          });
        }
      }
    } catch (graphqlError) {
      console.error(
        "Error fetching LeetCode contests from GraphQL:",
        graphqlError
      );
      // Continue with the contests we already scraped
    }

    // Remove duplicates (based on title and start time)
    const uniqueContests = [];
    const seen = new Set();

    for (const contest of contests) {
      const key = `${contest.name}-${contest.startTime.getTime()}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueContests.push(contest);
      }
    }

    return uniqueContests;
  } catch (error) {
    console.error("Error fetching LeetCode contests:", error);
    return [];
  }
}

// Update contests in the database
async function updateContests() {
  try {
    console.log("Starting contest update process...");

    // Fetch contests from all platforms
    const [codeforcesContests, codechefContests, leetcodeContests] =
      await Promise.all([
        fetchCodeforcesContests(),
        fetchCodeChefContests(),
        fetchLeetCodeContests(),
      ]);

    console.log(
      `Fetched: ${codeforcesContests.length} Codeforces, ${codechefContests.length} CodeChef, ${leetcodeContests.length} LeetCode contests`
    );

    const allContests = [
      ...codeforcesContests,
      ...codechefContests,
      ...leetcodeContests,
    ];

    // Update database
    let updatedCount = 0;
    let newCount = 0;

    for (const contest of allContests) {
      const result = await Contest.findOneAndUpdate(
        { id: contest.id },
        contest,
        { upsert: true, new: true }
      );

      if (result.isNew) {
        newCount++;
      } else {
        updatedCount++;
      }
    }

    console.log(
      `Contest update complete: ${newCount} new contests added, ${updatedCount} contests updated`
    );

    // Optional: Clean up old contests
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    const deleteResult = await Contest.deleteMany({
      endTime: { $lt: twoMonthsAgo },
      platform: { $in: ["codechef", "leetcode"] }, // Keep Codeforces history longer
    });

    console.log(`Cleaned up ${deleteResult.deletedCount} old contests`);

    return allContests.length;
  } catch (error) {
    console.error("Error updating contests:", error);
    return 0;
  }
}

// User routes for bookmarks
app.post("/api/bookmarks", async (req, res) => {
  try {
    const { email, contestId } = req.body;

    if (!email || !contestId) {
      return res
        .status(400)
        .json({ error: "Email and contestId are required" });
    }

    // Find user or create if doesn't exist
    let user = await User.findOne({ email });

    if (!user) {
      user = new User({ email, bookmarkedContests: [contestId] });
    } else {
      // Toggle bookmark
      if (user.bookmarkedContests.includes(contestId)) {
        user.bookmarkedContests = user.bookmarkedContests.filter(
          (id) => id !== contestId
        );
      } else {
        user.bookmarkedContests.push(contestId);
      }
    }

    await user.save();
    res.json({ bookmarkedContests: user.bookmarkedContests });
  } catch (error) {
    console.error("Error updating bookmarks:", error);
    res.status(500).json({ error: "Failed to update bookmarks" });
  }
});

app.get("/api/bookmarks/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const user = await User.findOne({ email });

    if (!user) {
      return res.json({ bookmarkedContests: [] });
    }

    res.json({ bookmarkedContests: user.bookmarkedContests });
  } catch (error) {
    console.error("Error fetching bookmarks:", error);
    res.status(500).json({ error: "Failed to fetch bookmarks" });
  }
});

// Get bookmarked contests with details
app.get("/api/bookmarked-contests/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const user = await User.findOne({ email });

    if (!user || user.bookmarkedContests.length === 0) {
      return res.json([]);
    }

    const bookmarkedContests = await Contest.find({
      id: { $in: user.bookmarkedContests },
    }).sort({ startTime: 1 });

    res.json(bookmarkedContests);
  } catch (error) {
    console.error("Error fetching bookmarked contests:", error);
    res.status(500).json({ error: "Failed to fetch bookmarked contests" });
  }
});

// Force update contests
app.post("/api/update-contests", async (req, res) => {
  try {
    const count = await updateContests();
    res.json({ message: `Successfully updated ${count} contests` });
  } catch (error) {
    console.error("Error in manual contest update:", error);
    res.status(500).json({ error: "Failed to update contests" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// Schedule contest updates
// Run every 6 hours
cron.schedule("0 */6 * * *", async () => {
  console.log("Running scheduled contest update...");
  await updateContests();
});

// Initial update on server start
setTimeout(async () => {
  console.log("Performing initial contest update...");
  await updateContests();
}, 5000); // Wait 5 seconds after server start

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
