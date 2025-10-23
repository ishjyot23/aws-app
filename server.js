import express from "express";
import bodyParser from "body-parser";
import AWS from "aws-sdk";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import cors from "cors";



dotenv.config();
const app = express();
app.use(bodyParser.json());
app.use(cors());

AWS.config.update({ region: process.env.AWS_REGION });

// Initialize services
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const cognito = new AWS.CognitoIdentityServiceProvider();



// ========== 1️⃣ SIGNUP / LOGIN WITH COGNITO ==========
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  try {
    await cognito
      .signUp({
        ClientId: process.env.CLIENT_ID,
        Username: email,
        Password: password,
      })
      .promise();
    res.json({ message: "Signup successful! Check your email for verification." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get("/confirm", async (req, res) => {
  const { username, code } = req.query;
  try {
    await cognito.adminConfirmSignUp({
      UserPoolId: process.env.USER_POOL_ID,
      Username: username,
    }).promise();
    res.redirect("/confirm.html");
  } catch (err) {
    res.status(400).send("Error confirming user: " + err.message);
  }
});

app.post("/login", async (req, res) => {
  const { email, username, password } = req.body;

  // Prefer username if provided; fallback to email
  const loginId = username || email;

  if (!loginId || !password) {
    return res.status(400).json({ error: "Username/email and password are required" });
  }

  try {
    const data = await cognito
      .initiateAuth({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: process.env.CLIENT_ID, // from your App client (not pool)
        AuthParameters: {
          USERNAME: loginId,
          PASSWORD: password,
        },
      })
      .promise();

    res.json({
      message: "Login successful",
      token: data.AuthenticationResult.IdToken,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
const sns = new AWS.SNS({ apiVersion: '2010-03-31' });
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN; // create this topic in AWS SNS

// ========== 2️⃣ GROUP MANAGEMENT (DynamoDB) ==========
app.post("/createGroup", async (req, res) => {
  // FIX: Destructure 'GroupId' (lowercase 'd') to match client payload and DynamoDB key
  const { GroupId, GroupName, Description, email, Subject } = req.body;

  // FIX: Use GroupId in validation
  if (!GroupId || !GroupName || !email) {
    // NOTE: The error message here should still match the required fields
    return res.status(400).json({ error: "GroupId, GroupName and email are required" });
  }

  const timestamp = new Date().toISOString();

  const newGroup = {
    TableName: "Groups",
    Item: {
      GroupId, // FIX: Use GroupId to match the database's Partition Key
      GroupName,
      Subject: Subject,
      Description: Description || "",
      Members: [email],
      Roles: { [email]: "admin" },
      CreatedAt: timestamp,
      CreatedBy: email
    },
  };

  try {
    // --- Add SNS subscription for the creator/admin ---
    await sns.subscribe({
      Protocol: 'email',
      TopicArn: SNS_TOPIC_ARN,
      Endpoint: email, // creator's email
    }).promise();
    await dynamoDB.put(newGroup).promise();
    // --- Create folder in S3 (prefix with slash) ---
    const s3Params = {
      Bucket: "studynestgrp7",
      Key: `${GroupId}/`, // folder
    };
    await s3.putObject(s3Params).promise();
    res.json({ message: "✅ Group created successfully", group: newGroup.Item });
  } catch (err) {
    console.error(err);
    // Log the specific DynamoDB error if possible
    res.status(500).json({ error: err.message });
  }
});

// ========== 3️⃣ GET ALL GROUPS ==========
app.get("/groups", async (req, res) => {
  const params = {
    TableName: "Groups",
  };

  try {
    const data = await dynamoDB.scan(params).promise();

    // Send raw DynamoDB items directly
    res.json(data.Items);
  } catch (err) {
    console.error("Error fetching groups:", err);
    res.status(500).json({ error: "Failed to fetch groups" });
  }
});


// api-join to send email to notify admin
app.post('/api/join', async (req, res) => {
  const { groupId, userEmail } = req.body;

  try {
    const params = { TableName: 'Groups', Key: { GroupId: groupId } };
    const groupData = await dynamoDB.get(params).promise();
    if (!groupData.Item) return res.status(404).json({ error: 'Group not found' });

    const creatorEmail = groupData.Item.CreatedBy;

    // Send notification via SNS
    await sns.publish({
      TopicArn: SNS_TOPIC_ARN,
      Subject: `Join Request for "${groupData.Item.GroupName}"`,
      Message: `${userEmail} wants to join your group "${groupData.Item.GroupName}".`,
    }).promise();

    res.json({ message: 'Admin notified about join request' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send join request' });
  }
});

// ========== 3️⃣ FILE UPLOAD / ACCESS (S3) ==========

import multer from "multer";
import fs from "fs";

// Configure multer (temporary storage before upload)
const upload = multer({ dest: "uploads/" });

app.post("/api/upload", upload.single("file"), async (req, res) => {
  const { groupId } = req.body;
  const file = req.file;

  if (!groupId || !file) {
    return res.status(400).json({ error: "groupId and file are required" });
  }

  const fileStream = fs.createReadStream(file.path);
  console.log("🟡 Uploading to S3:", `${groupId}/${file.originalname}`);
  const params = {
    Bucket: "studynestgrp7",
    Key: `${groupId}/${file.originalname}`,
    Body: fileStream,
    ContentType: file.mimetype,
    ACL: "public-read"
  };

  try {
    const result = await s3.upload(params).promise();
    fs.unlinkSync(file.path); // clean temp file
    res.json({
      message: "✅ File uploaded successfully",
      fileUrl: result.Location,
    });
  } catch (err) {
    console.error("❌ S3 Upload Error:", err);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

// GET /api/view-materials?groupId=...
app.get("/api/view-materials", async (req, res) => {
  const { groupId } = req.query;
  if (!groupId) return res.status(400).json({ error: "groupId required" });

  const params = {
    Bucket: "studynestgrp7", 
    Prefix: `${groupId}/`           // all files in this folder
  };

  try {
    const data = await s3.listObjectsV2(params).promise();

    // Map to file name + URL
    const files = data.Contents.map(item => ({
      name: item.Key.split("/").pop(),
      url: `https://${params.Bucket}.s3.amazonaws.com/${encodeURIComponent(item.Key)}`
    }));

    res.json(files);
  } catch (err) {
    console.error("❌ S3 List Error:", err);
    res.status(500).json({ error: "Failed to list materials" });
  }
});


// ========== 4️⃣ GET GROUPS FOR A SPECIFIC USER ========== 
app.get('/api/user/groups', async (req, res) => {
  const { userEmail } = req.query;

  if (!userEmail) {
    return res.status(400).json({ error: "userEmail query parameter is required" });
  }

  const params = { TableName: 'Groups' };

  try {
    const data = await dynamoDB.scan(params).promise();
    console.log("🔍 Full DynamoDB Data:", JSON.stringify(data.Items, null, 2));

    const userGroups = data.Items
      .filter(group =>
        Array.isArray(group.Members) &&
        group.Members.some(member => {
          console.log("Group:", group.GroupName, "Members:", group.Members);
          return member.S === userEmail || member === userEmail;
        })
      )
      .map(group => ({
        name: group.GroupName,
        slug: group.GroupId,
        memberCount: group.Members.length,
        createdBy: group.CreatedBy,
        subject: group.Subject || "",
        description: group.Description || ""   // ✅ add this line
      }));

    res.json(userGroups);
  } catch (err) {
    console.error("❌ Error fetching user's groups:", err);
    res.status(500).json({ error: "Failed to fetch user groups" });
  }
});

// POST /api/group/add-member
app.post('/api/group/add-member', async (req, res) => {
  const { groupId, email } = req.body;

  if (!groupId || !email) {
    return res.status(400).json({ error: 'Missing groupId or email' });
  }

  try {
    // 1️⃣ Subscribe the new member to SNS
    const snsParams = {
      Protocol: 'email',       // must be literally 'email'
      TopicArn: SNS_TOPIC_ARN,
      Endpoint: email
    };
    await sns.subscribe(snsParams).promise();

    // 2️⃣ Add the member to DynamoDB "Members" list
    const updateParams = {
      TableName: 'Groups',
      Key: { GroupId: groupId }, // assuming GroupId is the PK
      UpdateExpression: 'SET Members = list_append(if_not_exists(Members, :emptyList), :newMember)',
      ExpressionAttributeValues: {
        ':newMember': [{ S: email }], // DynamoDB list of maps for each email
        ':emptyList': []
      },
      ReturnValues: 'UPDATED_NEW'
    };

    await dynamoDB.update(updateParams).promise();

    res.json({ message: 'Member added successfully and subscription sent.' });
  } catch (err) {
    console.error('Error adding member:', err);
    res.status(500).json({ error: 'Failed to add member' });
  }
});



// Middleware to authenticate JWT token from Cognito
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Expecting "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  try {
    // verify token (replace 'your-secret' if you’re using Cognito's JWKS verify later)
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) throw new Error("Invalid token");

    req.user = decoded.payload; // attach user info to request
    next();
  } catch (err) {
    res.status(403).json({ error: "Invalid or expired token." });
  }
}

app.listen(3000, () => console.log("✅ Server running on http://localhost:3000"));
