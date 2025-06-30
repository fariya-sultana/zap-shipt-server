const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");
const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);


const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());


const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ry0n7jv.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("parcelDB");
        const parcelCollection = db.collection("parcels");

        const paymentsCollection = db.collection("payments");

        app.get("/parcels", async (req, res) => {
            const parcels = await parcelCollection.find({}).toArray();
            res.send(parcels);
        });

        app.get('/parcels', async (req, res) => {
            try {
                const userEmail = req.query.email;
                const query = userEmail ? { created_by: userEmail } : {};
                const options = {
                    sort: { createdAt: -1 },
                }

                const parcels = await parcelCollection.find(query, options).toArray();
                res.send(parcels);
            } catch (error) {
                console.error('Error fetching parcels:', error);
                res.status(500).send({ message: 'Failed to get parcels' })
            }
        })

        app.get('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;

                const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });

                if (!parcel) {
                    return res.status(404).send({ message: 'parcel not found' })
                }

                res.send(parcel);
            } catch (error) {
                console.error('Error fetching parcel:', error);
                res.status(500).send({ message: 'Failed to fetch parcel' })
            }
        })

        app.post("/parcels", async (req, res) => {
            try {
                const newParcel = req.body;

                const result = await parcelCollection.insertOne(newParcel);
                res.status(201).send(result);
            } catch (error) {
                console.error("Error inserting parcel:", error);
                res.status(500).send({ message: "Failed to insert parcel" });
            }
        });

        app.post('/create-payment-intent', async (req, res) => {

            const amountInCents = req.body.amountInCents;

            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents,
                    currency: 'usd',
                    payment_method_types: ['card'],
                });

                res.json({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.get('/payments', async(req, res)=> {
            try{
                const userEmail = req.query.email;

                const query = userEmail ? {email: userEmail} : {};

                const options = {sort: {paid_At: -1}};

                const payments = await paymentsCollection.find(query, options).toArray();
                res.send(payments);
            }catch(error){
                console.error('Error fetching payment history:', error),
                res.status(500).send({message: 'Failed to get payments'})
            }
        } )

        app.post('/payments', async (req, res) => {
            try {
                const { parcelId, email, amount, paymentMethod, transactionId } = req.body;

                const updatedResult = await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            payment_status: "paid"
                        }
                    }
                )

                if (updatedResult.matchedCount === 0) {
                    return res.status(404).send({ message: 'Parcel not found or already paid' });
                }

                const paymentDoc = {
                    parcelId,
                    email,
                    amount,
                    paymentMethod,
                    transactionId,
                    paid_at_string: new Date().toISOString(),
                    paid_At: new Date(),
                }

                const paymentResult = await paymentsCollection.insertOne(paymentDoc);

                res.status(201).send({
                    message: 'Payment recorded and parcel marked as paid',
                    insertedId: paymentResult.insertedId
                });
            } catch (error) {
                console.error('Payment processing failed', error)
            }
        })


        app.delete('/parcels/:id', async (req, res) => {
            const { id } = req.params;

            try {
                const result = await parcelCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res.status(404).send({ message: 'Parcel not found or already deleted' });
                }

                res.send(result);
            } catch (error) {
                console.error('Delete error:', error);
                res.status(500).send({ message: 'Failed to delete parcel' });
            }
        });


        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get("/", (req, res) => {
    res.send("Welcome to the Zap Shift Server!");
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});